// Служебный код существующего сторожа: только метаданные, fenced intent и квитанции.
// Модель получает событие, но не тексты/ключи. Native send выполняет разрешённый инструмент Codex.
import {existsSync,readFileSync} from 'node:fs';import path from 'node:path';
import {dataPath} from '../src/lib/env.mjs';import {isMain} from '../src/lib/is-main.mjs';
import {intakeJobMetadata,intakeHealth} from '../src/bot/media-intake-cli.mjs';import {intakeLock} from '../src/bot/media-intake-store.mjs';
import {reconcileIntakeDispatch} from './intake-dispatch.mjs';import {durableJson,dispatchEnvelope,EDITORS} from './intake-dispatch-host.mjs';
const read=(f,d)=>existsSync(f)?JSON.parse(readFileSync(f,'utf8')):d;
const folderDefault=()=>dataPath('intake-dispatch');
const problemText={intake_delivery_problem:'Бот не смог получить файл или доставить карточку. Сообщения сохранены; оператору нужно проверить указанный материал.',editor_acceptance_delayed:'Редактор пока не подтвердил получение задания. Материалы сохранены, повторная передача удержана до проверки.',intake_api_unavailable:'Сторож не смог связаться с сервером. Получение новых заданий временно не подтверждено; оператору нужно проверить соединение.'};
export async function intakeWatchCycle({folder=folderDefault(),metadata=intakeJobMetadata,health=intakeHealth,now=Date.now()}={}){
 const unlock=intakeLock(path.join(folder,'dispatch.lock'));if(!unlock)return{status:'BUSY'};
 try{
  const file=path.join(folder,'outbox.json'),watchFile=path.join(folder,'native-watch.json'),watch=read(watchFile,{});let jobs,state,problem=null;
  try{jobs=await metadata();const h=await health();state=reconcileIntakeDispatch(read(file,{}),jobs);for(const item of Object.values(state))item.firstSeenAt||=new Date(now).toISOString();durableJson(file,state);
   if(h.unknownCards||h.failedCards||h.failedFiles||h.blockedEvents||h.stalePendingEvents)problem='intake_delivery_problem:'+JSON.stringify([h.unknownCards||0,h.failedCards||0,h.failedFiles||0,h.blockedEvents||0,h.stalePendingEvents||0,h.lastIncomingAt||null]);
   else if(Object.values(state).some(i=>['unknown','queued','sending'].includes(i.status)&&now-Date.parse(i.attemptedAt||i.firstSeenAt)>120000))problem='editor_acceptance_delayed';
  }catch{problem='intake_api_unavailable';}
  if(problem){const seen=new Set(watch.reportedProblems||[watch.problem].filter(Boolean));if(!seen.has(problem)){seen.add(problem);durableJson(watchFile,{checkedAt:new Date(now).toISOString(),problem,reportedProblems:[...seen].slice(-50)});const reason=problem.split(':')[0];return{status:'ERROR',reason,message:problemText[reason]};}if(!state)return{status:'NO_CHANGE',held:true};}
  else durableJson(watchFile,{checkedAt:new Date(now).toISOString(),problem:null,reportedProblems:[]});
  const busy=new Set(jobs.filter(j=>j.status==='claimed').map(j=>j.materialId));for(const i of Object.values(state))if(i.kind!=='answer'&&['queued','unknown','sending'].includes(i.status))busy.add(i.materialId);
  const item=Object.values(state).find(i=>i.status==='planned'&&(i.kind==='answer'||!busy.has(i.materialId)));
  const accepted=Object.values(state).filter(i=>i.status==='accepted').length;if(!item)return{status:'NO_CHANGE',accepted};
  const envelope=path.join(folder,'envelopes',item.dispatchId+'.json');durableJson(envelope,dispatchEnvelope(item));
  return{status:'EVENT',accepted,...dispatchEnvelope(item),threadId:EDITORS[item.owner],file:envelope};
 }finally{unlock();}
}
export function intakeWatchTransition(id,action,{folder=folderDefault()}={}){
 if(!/^[a-f0-9]{64}$/.test(id)||!['begin','queued'].includes(action))throw Error('invalid dispatch action');
 const unlock=intakeLock(path.join(folder,'dispatch.lock'));if(!unlock)return{status:'BUSY'};
 try{const file=path.join(folder,'outbox.json'),state=read(file,{}),item=state[id];if(!item)throw Error('unknown dispatch');
  if(action==='begin'){if(item.status!=='planned')return{status:'RECONCILE'};item.status='sending';item.attemptedAt=new Date().toISOString();}
  else{if(!['sending','unknown'].includes(item.status))return{status:'RECONCILE'};item.status='queued';}
  durableJson(file,state);return{status:action==='begin'?'SEND':'QUEUED'};
 }finally{unlock();}
}
if(isMain(import.meta.url)){
 const flag=process.argv.slice(2).find(x=>/^--(?:begin|queued)=/.test(x));
 Promise.resolve().then(()=>flag?intakeWatchTransition(flag.slice(flag.indexOf('=')+1),flag.startsWith('--begin')?'begin':'queued'):intakeWatchCycle()).then(r=>console.log(JSON.stringify(r)),()=>{console.log(JSON.stringify({status:'ERROR',reason:'watch_state_unavailable',message:'Сторож не смог прочитать своё состояние. Автоматический повтор удержан, чтобы не передать материал дважды; нужна проверка оператора.'}));process.exitCode=2;});
}
