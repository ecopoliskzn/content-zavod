// Реальный служебный приём на сервере. По умолчанию выключен; конфигурация пилота
// хранится закрыто. Общие server/admin/runner подключает S0, данный файл не запускает сервер.
import {existsSync,readFileSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {dataPath,env,list} from '../lib/env.mjs';
import {tg} from '../lib/telegram.mjs';
import {createIntake} from './media-intake.mjs';
import {verifyIntakeResult,entryFromIntakeVariant} from './media-intake-delivery.mjs';
import {contentHash} from '../queue/format.mjs';
export {verifyIntakeResult};

const dir=()=>dataPath('media-intake');
let singleton;
const configFile=()=>dataPath('media-intake','config.json');
function currentConfig(){if(!existsSync(configFile()))return{enabled:false};try{return validateConfig(JSON.parse(readFileSync(configFile(),'utf8')));}catch{return{enabled:false};}}
export const isEnabled=()=>currentConfig().enabled===true;
export function instance(){
 if(!singleton)singleton=createIntake({dir:dir(),config:currentConfig,
  importFile:async a=>{const {importTelegramFile}=await import('../media/telegram-import.mjs');return importTelegramFile(a);},
  telegram:async(method,body)=>{const res=await tg(method,body,{retries:0});return{ok:res.kind==='ok'&&res.data?.ok===true,messageId:res.result?.message_id,uncertain:res.kind==='network'||res.status>=500};},verifyResult:verifyIntakeResult});
 return singleton;
}
export const ingest=update=>instance().ingest(update);
export const flush=()=>instance().flush();
export const handleUpdate=async update=>{const accepted=ingest(update);if(accepted.accepted)await flush();return accepted;};

// Предвыпускной gate для S0: изменение исходного задания нельзя обойти старой
// карточкой очереди. Не затрагивает чужие материалы и не публикует ничего сам.
export function publicationBlockers(entry){
 if(!String(entry?.material||'').startsWith('intake:'))return[];
 try{const id=entry.material.slice(7),state=instance().store.read(),r=state.materials[id];
  if(!r||r.mode!=='submitted'||entry.name!==`mi-${id}-${r.revision}`)return['готовность: исходное задание изменено или отменено; нужен актуальный вариант'];
  const j=Object.values(state.jobs).find(j=>j.materialId===id&&j.revision===r.revision&&j.status==='completed'&&j.artifactsVerified),v=j?.result?.variants?.find(v=>v.channel===entry.channel);
  if(!v||contentHash(entryFromIntakeVariant(v,j))!==contentHash(entry))return['готовность: публикационная версия не соответствует проверенному результату задания'];
  return[];
 }catch{return['готовность: состояние входящего задания недоступно; выпуск удержан до сверки'];}
}

function validateConfig(c){
 if(!c||typeof c.enabled!=='boolean'||!/^-[0-9]+$/.test(String(c.groupId))||!Number.isSafeInteger(c.topicId)||c.topicId<0)throw Error('нужны рабочая группа и тема');
 for(const key of ['authors','coordinators','approvers'])if(!Array.isArray(c[key])||(!c[key].length&&!(key==='coordinators'&&c.coordinatorMode==='operator-admin'))||c[key].some(x=>!/^\d+$/.test(String(x))))throw Error('нужны числовые роли');
 if(!['A','B'].includes(c.handoffMode)||!c.policyVersion)throw Error('нужны режим передачи и версия правил');
 if(!c.limits||['maxFiles','maxBytes','maxPending','maxText','maxJobInput','maxJobOutput','maxCalls'].some(k=>!Number.isSafeInteger(c.limits[k])||c.limits[k]<=0))throw Error('нужны пределы пилота');
 if(!Array.isArray(c.targets)||!c.targets.length||c.targets.some(t=>!['telegram','vk','instagram','threads','dzen','youtube','rutube'].includes(t.channel)||!t.account_ref||!t.format||!['auto','manual'].includes(t.delivery_mode)||t.readiness!=='passed'||!Number.isFinite(Date.parse(t.verified_at))))throw Error('нужны проверенные пути площадок');
 if(c.groupId!==env('TG_GROUP_ID')&&String(c.groupId)!==String(env('TG_GROUP_ID')))throw Error('приём разрешён только в настроенной группе');
 if(c.approvers.some(id=>!list('APPROVER_IDS').includes(String(id))))throw Error('роль утверждающего не выдаётся приёмником');
 return c;
}
// Вызывает только аутентифицированный admin-стык. actor берётся из его доверенного контекста.
export async function admin(command,args={},actor='operator'){
 if(!command.startsWith('intake-'))return null;
 const app=instance();try{let data;
 switch(command){
  case 'intake-configure':{const c=validateConfig(args.config);mkdirSync(dir(),{recursive:true,mode:0o700});writeFileSync(configFile()+'.tmp',JSON.stringify(c),{mode:0o600});renameSync(configFile()+'.tmp',configFile());data={enabled:c.enabled,topicConfigured:true,targetCount:c.targets.length,handoffMode:c.handoffMode};break;}
  case 'intake-info':
  case 'intake-status':data={enabled:currentConfig().enabled||false,materials:app.list().length,jobs:app.jobs().length,observations:app.store.read().observations};break;
  case 'intake-list':data=app.list();break;
  case 'intake-show':{const r=app.show(args.id);if(!r)throw Error('комплект не найден');data={id:r.id,revision:r.revision,mode:r.mode,files:r.files.map(({fileUniqueId,status,mediaId,errorCode,excluded})=>({fileUniqueId,status,mediaId,errorCode,excluded:!!excluded})),readiness:app.readiness(r.id)};break;}
  case 'intake-jobs':data=app.jobs().map(({id,materialId,revision,status,createdAt})=>({id,materialId,revision,status,createdAt}));break;
  case 'intake-claim':data=app.claim(args.id,args.owner,args.requestId);break;
  case 'intake-result':data=app.result(args.id,args.owner,args.token,args.result);break;
  case 'intake-release':data=app.release(args.id,args.owner,args.token);break;
  case 'intake-question':data=app.question(args.id,args.owner,args.token,args.question);break;
  case 'intake-facts':data=app.facts(args.id,args.revision,args.jobId,args.owner,args.token,args.facts);break;
  case 'intake-context':data=app.context(args.id,args.owner,args.token);break;
  case 'intake-edit':{const changed=app.edit(args.id,args.revision,args.userId,args.patch);data={ok:true,id:changed.id,revision:changed.revision};break;}
  case 'intake-prepare':data=app.prepare(args.id,args.revision,args.userId);break;
  case 'intake-retry':data=app.retry(args.id,args.revision,args.userId);break;
  case 'intake-reconcile-card':data=app.store.tx(s=>{const r=s.materials[args.id];if(!r||!Number.isSafeInteger(args.messageId)||args.messageId<=0||args.confirmed!==true)throw Error('нужна подтверждённая карточка');r.card={status:'sent',messageId:args.messageId,dirty:true};return{ok:true};});break;
  default:return{code:1,lines:['Неизвестная команда приёма']};
 }
 return{code:data?.ok===false?1:0,lines:[data?.ok===false?'Действие не выполнено; причина в структурированном результате':'Служебная команда выполнена'],data};
 }catch{return{code:1,lines:['Действие приёма отклонено: проверьте версию, полномочия, конфигурацию и доказательства.']};}
}
