#!/usr/bin/env node
// Явный забор готового задания существующей сессией S1/S2. Пустой опрос не зовёт LLM.
// Квитанция claim хранится закрытым файлом, её токен не выводится и не попадает в Git.
import {mkdirSync,readFileSync,writeFileSync,existsSync,renameSync,openSync,closeSync,fsyncSync} from 'node:fs';import path from 'node:path';import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';import {dataPath,env,wrongUser} from '../lib/env.mjs';
import {request} from '../lib/http.mjs';
import {editorTaskView,editorSourceView} from './media-intake-editor-view.mjs';
import {dispatchMetadata} from '../../ops/intake-dispatch.mjs';
import {intakeLock} from './media-intake-store.mjs';
const safeJson=file=>{if(path.extname(file)!=='.json')throw Error('ожидается JSON-файл');return JSON.parse(readFileSync(file,'utf8'));};
export async function intakeHealth(){return call('intake-health',{});}
function writeReceipt(file,value){const temp=file+'.tmp';writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});const fd=openSync(temp,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,file);}
export async function claimIntakeJob(id,owner,{invoke=call,folder=dataPath('intake-editor'),save=writeReceipt,requestId,expected}={}){
 if(!/^[a-f0-9]{16}$/.test(id||'')||!['S1','S2'].includes(owner))throw Error('нужны --id и --owner=S1|S2');
 if(requestId!==undefined&&!/^[a-f0-9]{32}$/.test(requestId))throw Error('неверный requestId');
 mkdirSync(folder,{recursive:true,mode:0o700});const file=path.join(folder,id+'.json'),intentFile=path.join(folder,id+'.request.json');
 if(existsSync(file)){const prior=safeJson(file);if(prior.owner!==owner||prior.job?.id!==id||requestId&&prior.requestId!==requestId)throw Error('другой владелец или dispatch');if(!prior.released)return file;renameSync(file,path.join(folder,id+'.released-'+prior.requestId+'.json'));}
 if(existsSync(intentFile)){const prior=safeJson(intentFile);const archive=path.join(folder,id+'.released-'+prior.requestId+'.json');if(existsSync(archive))renameSync(intentFile,archive+'.request.json');}
 let intent;
 if(existsSync(intentFile))intent=safeJson(intentFile);
 else{intent={schema:1,id,owner,requestId:requestId||randomUUID().replace(/-/g,'')};writeFileSync(intentFile,JSON.stringify(intent),{mode:0o600,flag:'wx'});const fd=openSync(intentFile,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}}
 if(intent.id!==id||intent.owner!==owner||!/^[a-f0-9]{32}$/.test(intent.requestId)||requestId&&intent.requestId!==requestId)throw Error('квитанция другого запроса');
 const claim=await invoke('intake-claim',{id,owner,requestId:intent.requestId,...(expected?{expected}:{})});if(!claim?.ok||!claim.token||claim.job?.id!==id)throw Error('задание не принято');
 save(file,{schema:1,owner,requestId:intent.requestId,...claim});return file;
}
export async function refreshClaimContext(file,{invoke=call,save=writeReceipt}={}){
 const claim=safeJson(file);if(!claim.job?.id||!claim.token||!['S1','S2'].includes(claim.owner))throw Error('нужна квитанция');
 const context=await invoke('intake-context',{id:claim.job.id,owner:claim.owner,token:claim.token});
 if(context?.ok===false||!Number.isSafeInteger(context?.revision))throw Error('контекст не подтверждён');
 const next={...claim,contextRevision:context.revision,context,...(context.job?{job:context.job}:{})};save(file,next);return next;
}
export async function annotateClaimFacts(file,facts,{invoke=call,save=writeReceipt}={}){
 const claim=await refreshClaimContext(file,{invoke,save});
 const response=await invoke('intake-facts',{id:claim.job.materialId,jobId:claim.job.id,revision:claim.contextRevision,owner:claim.owner,token:claim.token,facts});
 if(!response?.ok||!response.job?.inputHash)throw Error('факты не применены к актуальному заданию');
 save(file,{...claim,job:response.job,contextRevision:response.revision});return response;
}
export async function submitClaimResult(file,value,{invoke=call,save=writeReceipt}={}){
 const unlock=intakeLock(file+'.result.lock');if(!unlock)throw Error('результат уже передаётся');
 try{return await submitResultLocked(file,value,{invoke,save});}finally{unlock();}
}
async function submitResultLocked(file,value,{invoke,save}){
 const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex'),intentFile=file+'.result-intent.json',inputDigest=digest(value),prior=safeJson(file);
 if(existsSync(intentFile)){
  const intent=safeJson(intentFile);
  if(intent.jobId!==prior.job?.id||intent.owner!==prior.owner||intent.inputDigest!==inputDigest||intent.resultHash!==digest(intent.result))throw Error('неопределённый прежний результат требует сверки, payload не заменяется');
  if(intent.status==='accepted')return{ok:true,duplicate:true};
  const response=await invoke('intake-result',{id:prior.job.id,owner:prior.owner,token:prior.token,result:intent.result});
  if(!response?.ok)throw Error('сохранённый результат не подтверждён');save(intentFile,{...intent,status:'accepted'});return response;
 }
 const claim=await refreshClaimContext(file,{invoke,save}),job=claim.job;
 if(claim.schema!==1||!claim.token||value?.inputHash!==job.inputHash||!Array.isArray(value.variants))throw Error('нужна актуальная версия результата');
 const result=structuredClone(value);
 for(const variant of result.variants){
  if(!variant.entry)throw Error('нужен явный entry');
  const expected=job.input.targetFacts?.[`${variant.channel}:${variant.format}`]||job.input.targetFacts?.[variant.channel]||job.input.facts||[];
  if(variant.entry.facts===undefined){
   if(JSON.stringify(variant.factRefs)!==JSON.stringify(expected.map(f=>f.claim)))throw Error('явно подтвердите факты прочитанного варианта');
   variant.entry.facts=structuredClone(expected);
  }else if(JSON.stringify(variant.entry.facts)!==JSON.stringify(expected))throw Error('факты результата изменены');
  delete variant.factRefs;
 }
 const intent={schema:1,jobId:job.id,owner:claim.owner,inputDigest,resultHash:digest(result),result,status:'sending'};save(intentFile,intent);
 try{const response=await invoke('intake-result',{id:job.id,owner:claim.owner,token:claim.token,result});
  if(!response?.ok)throw Error('результат не принят');save(intentFile,{...intent,status:'accepted'});return response;
 }catch(error){save(intentFile,{...intent,status:'unknown'});throw error;}
}
export async function claimCurrentIntakeJob(id,owner,{invoke=call,...options}={}){
 const jobs=await invoke('intake-jobs',{}),j=Array.isArray(jobs)?jobs.find(j=>j.id===id):null;
 if(!j)throw Error('нет актуальных метаданных задания');
 let expected;if(j.protocolVersion===2){if(!dispatchMetadata(j)||j.recipient!==owner)throw Error('нет актуальной версии/роли');expected=Object.fromEntries(['materialId','revision','inputHash','protocolVersion','manifestRevision'].map(k=>[k,j[k]]));}
 return claimIntakeJob(id,owner,{...options,invoke,expected});
}
export async function acceptDispatchEnvelope(envelope,{invoke=call,folder=dataPath('intake-editor')}={}){
 const e=envelope;
 if(e?.schema!==1||!/^[a-f0-9]{64}$/.test(e.dispatchId||'')||e.requestId!==e.dispatchId.slice(0,32)||!dispatchMetadata({id:e.jobId,materialId:e.materialId,revision:e.revision,inputHash:e.inputHash,status:'queued',recipient:e.owner,protocolVersion:e.protocolVersion,manifestRevision:e.manifestRevision}))throw Error('неверный конверт');
 const expected={materialId:e.materialId,revision:e.revision,inputHash:e.inputHash,protocolVersion:e.protocolVersion,manifestRevision:e.manifestRevision};
 const file=await claimIntakeJob(e.jobId,e.owner,{invoke,folder,requestId:e.requestId,expected}),claim=safeJson(file),j=claim.job;
 if(j.materialId!==e.materialId||j.revision!==e.revision||(j.claim?.initialInputHash||j.inputHash)!==e.inputHash||j.protocolVersion!==e.protocolVersion||j.manifestRevision!==e.manifestRevision||j.recipient!==e.owner)throw Error('версия конверта устарела; сохранённый claim требует сверки');
 return file;
}
export async function acceptContinuationEnvelope(e,{invoke=call,folder=dataPath('intake-editor'),ackFolder=dataPath('intake-dispatch','acks')}={}){
 if(e?.schema!==1||e.kind!=='answer'||!/^[a-f0-9]{64}$/.test(e.dispatchId||'')||!/^[a-f0-9]{16}$/.test(e.jobId||'')||!/^[a-f0-9]{32}$/.test(e.requestId||'')||!/^[a-f0-9]{64}$/.test(e.answerHash||'')||!Number.isSafeInteger(e.answerRevision)||e.answerRevision<1)throw Error('неверное продолжение');
 const file=path.join(folder,e.jobId+'.json'),prior=safeJson(file);
 if(prior.owner!==e.owner||prior.requestId!==e.requestId||prior.job?.materialId!==e.materialId||prior.job?.revision!==e.revision)throw Error('продолжение не принадлежит текущему claim');
 const claim=await refreshClaimContext(file,{invoke});
 if(claim.context.answerRevision!==e.answerRevision||claim.context.answerHash!==e.answerHash)throw Error('ответ уже изменён; нужна актуальная сверка');
 mkdirSync(ackFolder,{recursive:true,mode:0o700});writeReceipt(path.join(ackFolder,e.dispatchId+'.json'),{schema:1,dispatchId:e.dispatchId,jobId:e.jobId,requestId:e.requestId,owner:e.owner,answerHash:e.answerHash,answerRevision:e.answerRevision,at:new Date().toISOString()});return file;
}
export async function intakeJobMetadata(){const jobs=await call('intake-jobs',{});if(!Array.isArray(jobs))throw Error('нет метаданных');return jobs.map(dispatchMetadata).filter(Boolean);}
async function call(cmd,args){
 if(env('QUEUE_API_BASE')){
  const readOnly=['intake-jobs','intake-health','intake-status','intake-show','intake-context'].includes(cmd);
  const res=await request(env('QUEUE_API_BASE').replace(/\/+$/,'')+'/admin/queue',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+env('ADMIN_API_TOKEN')},body:JSON.stringify({cmd,args,actor:'intake-editor-cli'}),timeoutMs:readOnly?10000:60000,retries:readOnly?1:0,retryDelayMs:500});
  if(res.kind!=='ok'||res.data?.code!==0)throw Error('сервер не подтвердил команду; перед повтором сверить статус');return res.data.data;
 }
 if(wrongUser())throw Error('команда выполняется пользователем завода');
 const runtime=await import('./media-intake-runtime.mjs');
 if(cmd==='intake-attach-original'){const {attachTelegramOriginal}=await import('../media/telegram-import.mjs');return attachTelegramOriginal(runtime.instance(),args);}
 const res=await runtime.admin(cmd,args,'intake-editor-cli');
 if(res.code!==0)throw Error('команда отклонена; проверьте версию и полномочия');
 if(cmd==='intake-result'){const {deliverIntakeResults}=await import('./media-intake-delivery.mjs');await deliverIntakeResults(runtime.instance());}
 return res.data;
}
export async function main(argv=process.argv.slice(2)){
 const action=argv[0]||'jobs',args=Object.fromEntries(argv.slice(1).map(x=>{const i=x.indexOf('=');return i>2?[x.slice(2,i),x.slice(i+1)]:[x.replace(/^--/,''),true];}));
 if(['jobs','status'].includes(action)){console.log(JSON.stringify(await call('intake-'+action,{}),null,2));return;}
 if(action==='attach-original'){
  const data=await call('intake-attach-original',{id:args.id,revision:Number(args.revision),fileUniqueId:args.file,mediaId:args.media});
  console.log(JSON.stringify(data));return;
 }
 if(action==='show'){console.log(JSON.stringify(await call('intake-show',{id:args.id}),null,2));return;}
 if(action==='claim'){
  const file=await claimCurrentIntakeJob(args.id,args.owner,{requestId:args['request-id']});
  console.log('Задание принято. Закрытая квитанция: '+file);return;
 }
 if(action==='accept'){
  const file=await acceptDispatchEnvelope(safeJson(args.envelope));console.log('Конверт принят. Закрытая квитанция: '+file);return;
 }
 if(action==='resume'){
  const file=await acceptContinuationEnvelope(safeJson(args.envelope));console.log('Продолжение принято; актуальный контекст сохранён. Закрытая квитанция: '+file);return;
 }
 if(action==='result'){
  await submitClaimResult(args.claim,safeJson(args.result));
  console.log('Результат принят. Варианты передаются на обычное согласование; публикация не одобрена.');return;
 }
 if(action==='context'){await refreshClaimContext(args.claim);console.log('Актуальный контекст сохранён в закрытой квитанции: '+args.claim);return;}
 if(action==='view'){console.log(JSON.stringify(editorTaskView(safeJson(args.claim)),null,2));return;}
 if(action==='source'){console.log(JSON.stringify(editorSourceView(safeJson(args.claim),args.id),null,2));return;}
 if(action==='preview'){const {intakePreview}=await import('../media/intake-preview.mjs');console.log(JSON.stringify(await intakePreview(args.claim,args.media,{refresh:refreshClaimContext}),null,2));return;}
 if(action==='facts'){await annotateClaimFacts(args.claim,safeJson(args.file));console.log('Факты проверены; актуальная версия задания сохранена в закрытой квитанции.');return;}
 if(['release','question'].includes(action)){
  const claim=safeJson(args.claim);
  if(!claim.job?.id||!claim.token||!['S1','S2'].includes(claim.owner))throw Error('нужна квитанция задания');
  const payload={id:claim.job.id,owner:claim.owner,token:claim.token};
  if(action==='question')payload.question=safeJson(args.file);
  const response=await call('intake-'+action,payload);if(response?.ok===false)throw Error('действие отклонено');
  if(action==='release')writeReceipt(args.claim,{...claim,released:true});
  console.log('Служебное действие подтверждено; проверьте актуальную версию задания.');return;
 }
 throw Error('команды: jobs, status, show, claim, result, release, question, facts');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Команда приёма не завершена. Проверьте параметры, доступ и состояние задания; секреты не выводятся.');process.exitCode=2;});
