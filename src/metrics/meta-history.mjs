// Ежедневная история собственных Instagram и Threads: отдельный неизменяемый снимок дня.
// Не читает тексты/переписку и не публикует. Пропуски и поправки счётчиков сохраняются явно.
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync,linkSync,unlinkSync} from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {collectBaseline,summarizeBaseline} from './meta-baseline.mjs';import {dataPath,env,wrongUser} from '../lib/env.mjs';import {lock} from '../lib/files.mjs';import {mskDate} from '../lib/time.mjs';import {isMain} from '../lib/is-main.mjs';
const DAY=86400000;
const valid=m=>m?.status==='measured'&&Number.isFinite(m.value)&&Number.isFinite(Date.parse(m.takenAt));
function difference(before,after){
 const compatible=valid(before)&&valid(after)&&Date.parse(after.takenAt)>Date.parse(before.takenAt)&&['source','period','field'].every(k=>before[k]===after[k]);
 const delta=compatible?after.value-before.value:null;
 return{before:valid(before)?before.value:null,after:valid(after)?after.value:null,from:before?.takenAt||null,to:after?.takenAt||null,delta,correction:delta!==null&&delta<0,status:compatible?'comparable':'not_comparable'};
}
export function compareSnapshots(before,after){return{from:before?.collectedFrom||null,to:after.collectedFrom,channels:after.channels.map(c=>{
 const old=before?.channels.find(b=>b.platform===c.platform),oldIds=new Map((old?.list||[]).map(p=>[p.id,p])),newIds=new Set(c.list.map(p=>p.id));
 return{platform:c.platform,followers:difference(old?.followers,c.followers),addedIds:c.list.filter(p=>!oldIds.has(p.id)).map(p=>p.id),absentIds:(old?.list||[]).filter(p=>!newIds.has(p.id)).map(p=>p.id),compositionComplete:Boolean(old?.inventoryComplete&&c.inventoryComplete),absenceMeaning:'Не обнаружено в текущем окне/выдаче, не доказательство удаления',posts:c.list.filter(p=>oldIds.has(p.id)).map(p=>{const b=oldIds.get(p.id),same=b.publishedAt===p.publishedAt&&b.format===p.format;return{id:p.id,publishedAt:p.publishedAt,metrics:Object.fromEntries(Object.entries(p.metrics).map(([name,m])=>[name,difference(same?b.metrics[name]:null,m)]))};})};
})};}
function previous(root,baselineRoot,now){
 const candidates=[];let unreadable=0;for(const folder of [root,baselineRoot].filter(Boolean))if(existsSync(folder))for(const name of readdirSync(folder).filter(n=>/^\d{4}-\d{2}-\d{2}(?:T[\d:.-]+Z)?\.json$/.test(n)).sort((a,b)=>b.replace(/\D/g,'').localeCompare(a.replace(/\D/g,'')))){
  // Достаточно последнего пригодного снимка в каждой папке, а не всей многолетней истории.
  try{const raw=JSON.parse(readFileSync(path.join(folder,name),'utf8')),s=raw.snapshot||raw;if(!Array.isArray(s.channels)||!Number.isFinite(Date.parse(s.collectedFrom))){unreadable++;continue;}if(Date.parse(s.collectedFrom)<now){candidates.push(s);break;}}catch{unreadable++;}
 }
 return{snapshot:candidates.sort((a,b)=>Date.parse(b.collectedFrom)-Date.parse(a.collectedFrom))[0]||null,unreadable};
}
function safeLink(value){try{const u=new URL(value);return u.protocol==='https:'&&['www.instagram.com','www.threads.com','www.threads.net'].includes(u.hostname)&&!u.username&&!u.password?u.origin+u.pathname:'';}catch{return '';}}
async function ownerCall(platform,q){
 if(platform==='instagram'){const {ig}=await import('../lib/ig.mjs');return ig(q,{retries:0,timeoutMs:20000});}
 const {request}=await import('../lib/http.mjs');const url=new URL('https://graph.threads.net/v1.0/'+q);url.searchParams.set('access_token',env('THREADS_TOKEN'));return request(url.href,{retries:0,timeoutMs:20000});
}
export async function collectDaily({now=Date.now(),root=dataPath('meta','history'),baselineRoot=null,call=ownerCall,delay}={}){
 if(wrongUser())throw Error('Запустите сбор под пользователем завода');
 const day=mskDate(now),file=path.join(root,day+'.json');mkdirSync(root,{recursive:true,mode:0o700});
 const unlock=lock(path.join(root,'collect.lock'),60*60*1000);if(!unlock)return{status:'BUSY'};
 try{
  if(existsSync(file)){const b=JSON.parse(readFileSync(file,'utf8'));if(b.version!==1||b.day!==day||!b.snapshot?.channels)throw Error('Существующий снимок повреждён');return{status:'ALREADY_COLLECTED',file,partial:b.partial};}
  const old=previous(root,baselineRoot,now),msk=new Date(now+3*3600000),weekday=msk.getUTCDay(),monday=Date.parse(day+'T00:00:00+03:00')-((weekday+6)%7)*DAY;
  const snapshot=await collectBaseline({call,from:new Date(now-60*DAY).toISOString(),to:new Date(monday).toISOString(),now,includeOwnText:false,shouldMeasure:r=>r.ageDaysAtCutoff<=14||weekday===1,maxPages:20,maxRequests:150,...(delay?{delay}:{})});
  for(const c of snapshot.channels)for(const row of c.list)row.permalink=safeLink(row.permalink);
  const partial=snapshot.channels.some(c=>c.status!=='ok'||!c.inventoryComplete||c.followers.status!=='measured'||c.errors.length||c.list.some(p=>Object.values(p.metrics).some(m=>!['measured','not_due'].includes(m.status))));
  const bundle={version:1,day,policy:{windowDays:60,freshDailyDays:14,olderMetrics:'Monday only',textsCollected:false},partial,warnings:old.unreadable?[{kind:'previous_snapshot_unreadable',count:old.unreadable}]:[],snapshot,aggregate:summarizeBaseline(snapshot),comparison:compareSnapshots(old.snapshot,snapshot)};
  const temp=path.join(root,'.'+randomUUID()+'.tmp');try{writeFileSync(temp,JSON.stringify(bundle,null,2)+'\n',{flag:'wx',mode:0o600});linkSync(temp,file);}finally{if(existsSync(temp))unlinkSync(temp);}
  return{status:'COLLECTED',file,partial,requests:snapshot.requests,channels:snapshot.channels.map(c=>({platform:c.platform,followers:c.followers.value,posts:c.list.length,inventoryComplete:c.inventoryComplete,metricsComplete:c.metricsComplete,notDue:c.list.filter(p=>Object.values(p.metrics).some(m=>m.status==='not_due')).length}))};
 }finally{unlock();}
}
if(isMain(import.meta.url))collectDaily({baselineRoot:dataPath('meta','baseline')}).then(r=>{console.log(JSON.stringify(r));if(r.partial)process.exitCode=2;},()=>{console.error('История Meta не записана: проверьте окружение и права, значения ключей скрыты.');process.exitCode=2;});
