// Дешёвый сторож очереди: сравнение выполняет код, модель получает только флаг изменения.
// Не редактирует и не публикует материалы. Новые события кладёт в локальный outbox;
// отметка доставки ставится только после успешной передачи основной сессии.
// Ключи читает штатный загрузчик, значения и сырые ответы API никогда не печатает.
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {lock} from '../src/lib/files.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const TARGETS=['ffe75ad066f9ea5f','fda3e7578d62a698','f07defb6acd90d31'];
const hash=value=>createHash('sha256').update(value).digest('hex');
export const remarkFingerprint=(id,note)=>hash(id+'\n'+note);
const safeLink=value=>{try{const u=new URL(value);if(!['https:'].includes(u.protocol)||!/(^|\.)(instagram\.com|youtube\.com|youtu\.be)$/.test(u.hostname))return null;const v=u.hostname.endsWith('youtube.com')?u.searchParams.get('v'):null;u.username='';u.password='';u.search='';u.hash='';if(v)u.searchParams.set('v',v);return u.toString();}catch{return null;}};

/** Чистое сравнение. Лишние поля сервера и авторы замечаний сюда не копируются. */
export function detectChanges(inbox,entries,state={}){
 const known=new Set([...(state.handledRemarkFingerprints||[]),...(state.dispatched||[])]);
 const own=new Map(entries.filter(e=>TARGETS.includes(e.id)&&['youtube','instagram'].includes(e.channel)).map(e=>[e.id,e]));
 const events=[],observed={};
 for(const item of inbox){
  const e=own.get(item.id);if(!e||e.status!=='rework'||typeof item.note!=='string'||!item.note.trim())continue;
  const note=item.note.slice(0,1500),key=remarkFingerprint(e.id,note);
  if(!known.has(key))events.push({key,type:'remark',id:e.id,channel:e.channel,name:String(e.name||''),note});
 }
 for(const e of own.values()){
  const result={id:e.result?.id||null,link:safeLink(e.result?.link)};
  const key=hash(JSON.stringify({id:e.id,status:e.status,contentHash:e.contentHash||'',approvedAt:e.approval?.at||null,result}));
  const previous=state.observed?.[e.id],oldStatus=previous?.status??state.statuses?.[e.id];
  observed[e.id]={status:e.status,key};
  const changed=previous?previous.key!==key:oldStatus!==undefined&&oldStatus!==e.status;
  if(changed&&['approved','published','failed','handed','expired','cancelled'].includes(e.status)&&!known.has(key))events.push({key,type:'status',id:e.id,channel:e.channel,name:String(e.name||''),status:e.status,result});
 }
 return {events,observed};
}

export function acknowledgeBatch(state,id){
 if(!state.pending||state.pending.id!==id||!state.pending.attempted)throw Error('Нет соответствующей начатой передачи');
 return {...state,observed:state.pending.observed,dispatched:[...new Set([...(state.dispatched||[]),...state.pending.events.map(e=>e.key)])],pending:null};
}

function readJson(file,fallback){return existsSync(file)?JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,'')):fallback;}
function writeJson(file,value){const temp=file+'.'+process.pid+'.tmp';writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});renameSync(temp,file);}

async function cli(){
 const folder=path.join(ROOT,'content','reports','monitoring');mkdirSync(folder,{recursive:true});
 const file=path.join(folder,'review-watch.json'),unlock=lock(file+'.lock',120000);
 if(!unlock){console.log(JSON.stringify({status:'BUSY'}));return;}
 try{
  let state=readJson(file,null);
  if(!state){const old=readJson(path.join(folder,'instagram-youtube.json'),{});state={version:1,handledRemarkFingerprints:old.handledRemarkFingerprints||[],statuses:old.statuses||{},dispatched:[],pending:null};}
  const ack=process.argv.find(x=>x.startsWith('--ack='))?.slice(6),begin=process.argv.find(x=>x.startsWith('--begin='))?.slice(8);
  const output=()=>console.log(JSON.stringify({status:state.pending?'EVENT':'NO_CHANGE',...(state.pending?{batchId:state.pending.id,file:path.join(folder,'review-batches',state.pending.id+'.json'),attempted:!!state.pending.attempted,count:state.pending.events.length}:{})}));
  if(ack||begin){
   const id=ack||begin;if(!/^[a-f0-9]{64}$/.test(id)||state.pending?.id!==id)throw Error('Неверный пакет');
   if(ack){state=acknowledgeBatch(state,id);writeJson(file,state);console.log(JSON.stringify({status:'ACKNOWLEDGED',batchId:id}));return;}
   if(state.pending.attempted){console.log(JSON.stringify({status:'RECONCILE',batchId:id}));return;}
   state.pending.attempted=true;writeJson(file,state);console.log(JSON.stringify({status:'SEND',batchId:id}));return;
  }
  if(state.pending){output();return;}
  const {env}=await import('../src/lib/env.mjs');const {request}=await import('../src/lib/http.mjs');
  const api=env('QUEUE_API_BASE'),token=env('ADMIN_API_TOKEN');
  const call=async(cmd,args={})=>{
   if(!api||!token)throw Error('configuration');
   const r=await request(api.replace(/\/+$/,'')+'/admin/queue',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({cmd,args,actor:'сторож правок'}),timeoutMs:10000,retries:0});
   if(r.kind!=='ok'||r.data?.code!==0)throw Error((r.kind||'invalid')+':'+(Number(r.status)||0)+':'+(Number(r.data?.code)||0));
   return r.data.data;
  };
  let changes;
  try{
   const inbox=await call('inbox');if(!Array.isArray(inbox))throw Error('invalid_inbox');
   const entries=[];for(const id of TARGETS){const e=await call('show',{ref:id});if(!e||e.id!==id)throw Error('invalid_entry');entries.push(e);}
   changes=detectChanges(inbox,entries,state);state.lastError=null;
  }catch(error){
   // Только фиксированный вид ошибки и HTTP-код: не сохраняем исключения/ответы сети.
   const reason=/^(configuration|invalid_inbox|invalid_entry|(?:ok|refused|network|invalid):\d+:\d+)$/.test(error.message)?error.message:'request_failed';
   const key=hash('monitor_error:'+reason);state.lastError=reason;
   changes={events:(state.dispatched||[]).includes(key)?[]:[{key,type:'monitor_error',reason}],observed:state.observed||{}};
  }
  state.checkedAt=new Date().toISOString();
  if(changes.events.length){
   const id=hash(changes.events.map(e=>e.key).sort().join('\n'));const batches=path.join(folder,'review-batches');mkdirSync(batches,{recursive:true});
   const batchFile=path.join(batches,id+'.json');if(!existsSync(batchFile))writeJson(batchFile,{version:1,batchId:id,createdAt:state.checkedAt,targetThreadId:'01a1439c-0fdc-79d2-bce1-3968327bb807',events:changes.events});
   state.pending={id,events:changes.events,observed:changes.observed,attempted:false};
  }else state.observed=changes.observed;
  writeJson(file,state);output();
 }finally{unlock();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))cli().catch(()=>{console.log(JSON.stringify({status:'ERROR',reason:'watcher_failed'}));process.exitCode=2;});
