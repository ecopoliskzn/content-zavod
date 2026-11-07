// Закрытое служебное состояние приёма: одна атомарная запись под коротким замком.
// Повреждение не считается пустой очередью. Сетевые вызовы выполняются вне транзакции.
import {existsSync,mkdirSync,readFileSync,writeFileSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {wrongUser} from '../lib/env.mjs';

// Только доказанно умерший PID допускает снятие замка. Живой/неизвестный — отказ.
// Время не считается доказательством смерти. Дополнительный recovery-lock сериализует восстановление.
export function intakeLock(file){
 mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const token=JSON.stringify({pid:process.pid,token:randomUUID()});
 const take=()=>{try{writeFileSync(file,token,{flag:'wx',mode:0o600});return true;}catch{return false;}};
 const dead=p=>{try{if(!Number.isSafeInteger(p)||p<=0)return false;process.kill(p,0);return false;}catch(e){return e.code==='ESRCH';}};
 if(!take()){
  const recovery=file+'.recovery';let held=false;
  try{writeFileSync(recovery,token,{flag:'wx',mode:0o600});held=true;
   const old=JSON.parse(readFileSync(file,'utf8'));if(!dead(old.pid))return null;
   unlinkSync(file);if(!take())return null;
  }catch{return null;}finally{if(held)try{unlinkSync(recovery);}catch{}}
 }
 return()=>{try{if(readFileSync(file,'utf8')===token)unlinkSync(file);}catch{}};
}

export function intakeStore(dir){
 const file=path.join(dir,'state.json');
 function read(){
  if(!existsSync(file))return {schema:1,events:{},materials:{},jobs:{},observations:[],config:null};
  try{const s=JSON.parse(readFileSync(file,'utf8'));if(s.schema!==1||!s.events||!s.materials||!s.jobs)throw Error();return s;}
  catch{throw Error('состояние приёма повреждено: требуется восстановление, запись остановлена');}
 }
 function tx(fn){
  const foreign=wrongUser();if(foreign)throw Error('неверный пользователь сервера');
  mkdirSync(dir,{recursive:true,mode:0o700});const unlock=intakeLock(path.join(dir,'state.lock'));if(!unlock)throw Error('приём занят: повторите безопасную команду');
  try{const state=read(),result=fn(state);const tmp=path.join(dir,'.state-'+randomUUID()),bytes=JSON.stringify(state);
   if(Buffer.byteLength(bytes)>16*1024*1024)throw Error('журнал приёма достиг предела пилота; новое событие не подтверждено');
   writeFileSync(tmp,bytes,{mode:0o600,flag:'wx'});const fd=openSync(tmp,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,file);
   return structuredClone(result??null);
  }finally{unlock();}
 }
 return{read,tx,dir};
}
