#!/usr/bin/env node
// Явный забор готового задания существующей сессией S1/S2. Пустой опрос не зовёт LLM.
// Квитанция claim хранится закрытым файлом, её токен не выводится и не попадает в Git.
import {mkdirSync,readFileSync,writeFileSync,existsSync,renameSync,openSync,closeSync,fsyncSync} from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';import {dataPath,env,wrongUser} from '../lib/env.mjs';
import {request} from '../lib/http.mjs';
const safeJson=file=>{if(path.extname(file)!=='.json')throw Error('ожидается JSON-файл');return JSON.parse(readFileSync(file,'utf8'));};
function writeReceipt(file,value){const temp=file+'.tmp';writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});const fd=openSync(temp,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,file);}
export async function claimIntakeJob(id,owner,{invoke=call,folder=dataPath('intake-editor'),save=writeReceipt}={}){
 if(!/^[a-f0-9]{16}$/.test(id||'')||!['S1','S2'].includes(owner))throw Error('нужны --id и --owner=S1|S2');
 mkdirSync(folder,{recursive:true,mode:0o700});const file=path.join(folder,id+'.json'),intentFile=path.join(folder,id+'.request.json');
 if(existsSync(file)){const prior=safeJson(file);if(prior.owner!==owner||prior.job?.id!==id)throw Error('другой владелец');if(!prior.released)return file;renameSync(file,path.join(folder,id+'.released-'+prior.requestId+'.json'));}
 if(existsSync(intentFile)){const prior=safeJson(intentFile);const archive=path.join(folder,id+'.released-'+prior.requestId+'.json');if(existsSync(archive))renameSync(intentFile,archive+'.request.json');}
 let intent;
 if(existsSync(intentFile))intent=safeJson(intentFile);
 else{intent={schema:1,id,owner,requestId:randomUUID().replace(/-/g,'')};writeFileSync(intentFile,JSON.stringify(intent),{mode:0o600,flag:'wx'});const fd=openSync(intentFile,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}}
 if(intent.id!==id||intent.owner!==owner||!/^[a-f0-9]{32}$/.test(intent.requestId))throw Error('квитанция другого запроса');
 const claim=await invoke('intake-claim',{id,owner,requestId:intent.requestId});if(!claim?.ok||!claim.token||claim.job?.id!==id)throw Error('задание не принято');
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
async function call(cmd,args){
 if(env('QUEUE_API_BASE')){
  const res=await request(env('QUEUE_API_BASE').replace(/\/+$/,'')+'/admin/queue',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+env('ADMIN_API_TOKEN')},body:JSON.stringify({cmd,args,actor:'intake-editor-cli'}),timeoutMs:60000,retries:0});
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
  const file=await claimIntakeJob(args.id,args.owner);
  console.log('Задание принято. Закрытая квитанция: '+file);return;
 }
 if(action==='result'){
  const claim=safeJson(args.claim),result=safeJson(args.result);
  if(claim.schema!==1||!claim.job?.id||!claim.token||!['S1','S2'].includes(claim.owner))throw Error('нужна квитанция принятого задания');
  const response=await call('intake-result',{id:claim.job.id,owner:claim.owner,token:claim.token,result});
  if(!response?.ok)throw Error('результат не принят');console.log('Результат принят. Варианты передаются на обычное согласование; публикация не одобрена.');return;
 }
 if(action==='context'){await refreshClaimContext(args.claim);console.log('Актуальный контекст сохранён в закрытой квитанции: '+args.claim);return;}
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
