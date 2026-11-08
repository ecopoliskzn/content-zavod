// Подготовленные варианты попадают только в штатную очередь и на обычное согласование.
// Квитанции связывают job с точной записью. Неизвестный исход отправки сначала сверяется.
import {existsSync,readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import path from 'node:path';
import {lock} from '../lib/files.mjs';import {rows,blobPath} from '../media/library.mjs';
import {execute} from '../queue/commands.mjs';import {get} from '../queue/store.mjs';
import {normalize,validate,contentHash} from '../queue/format.mjs';import {check} from '../gates/index.mjs';
import {mskDate,mskTime} from '../lib/time.mjs';
/** Транспортные поля задаёт код по заданию; модель поставляет только содержимое. */
export function entryFromIntakeVariant(v,job){
 const target=job.targets.find(t=>t.channel===v.channel);
 if(!target||target.format!==v.format||!['album','photopost','photo-post','carousel'].includes(v.format)||typeof v.text!=='string'||!v.text.trim())throw Error('target');
 const raw=v.entry||{};
 if(raw.text!==v.text||Object.keys(raw).some(k=>!['channel','kind','name','material','text','media','facts','date','time'].includes(k)))throw Error('payload');
 if(raw.channel!==v.channel||raw.kind!=='post'||raw.name!==`mi-${job.materialId}-${job.revision}`||raw.material!==`intake:${job.materialId}`)throw Error('identity');
 const facts=job.input.facts||[];
 if(JSON.stringify(raw.facts||[])!==JSON.stringify(facts)||!Array.isArray(raw.media)||raw.media.some(m=>Object.keys(m).some(k=>!['type','mediaId'].includes(k))||m.type!=='image'))throw Error('media_or_facts');
 const t=job.input.timing||{mode:'after_approval'},at=t.at?Date.parse(t.at):Date.now();
 let timing;
 if(t.mode==='after_approval'||t.mode==='choose_later')timing={mode:'after-approval'};
 else if(t.mode==='not_before')timing={mode:'not-before',date:mskDate(at),time:mskTime(at),notBefore:t.at};
 else if(t.mode==='at')timing={mode:'at',date:mskDate(at),time:mskTime(at),expireAt:t.at};
 else throw Error('timing');
 return normalize({channel:v.channel,kind:'post',name:`mi-${job.materialId}-${job.revision}`,material:`intake:${job.materialId}`,text:v.text,media:raw.media.map(m=>({type:m.type,mediaId:m.mediaId})),facts,date:mskDate(at),time:mskTime(at),timing});
}
export function verifyIntakeResult(value,job){
 try{
  if(value?.inputHash!==job.inputHash||value.editorialReview?.result!=='passed'||value.editorialReview.policyVersion!==job.input?.policyVersion||!Array.isArray(value.variants)||value.variants.length!==job.targets.length)return false;
  const all=rows(),originals=new Set(job.input.files.map(f=>f.mediaId)),seen=new Set();
  for(const v of value.variants){
   const target=job.targets.find(t=>t.channel===v.channel);if(!target||seen.has(v.channel)||target.format!==v.format)return false;seen.add(v.channel);
   const e=entryFromIntakeVariant(v,job);if(validate(e).length||check(e).block.length)return false;
   if(!Array.isArray(v.mediaIds)||!e.media?.length||e.media.some(m=>m.url||m.cover||m.coverMediaId)||e.media.length!==v.mediaIds.length)return false;
   for(let i=0;i<e.media.length;i++){
    const m=e.media[i],r=all.find(r=>r.mediaId===m.mediaId);
    if(m.mediaId!==v.mediaIds[i]||!r||r.role!=='publication'||!originals.has(r.parent)||r.material!==e.material||!existsSync(blobPath(r)))return false;
    if((m.type==='image'&&!r.mime.startsWith('image/'))||(m.type==='video'&&!r.mime.startsWith('video/')))return false;
    const bytes=readFileSync(blobPath(r));if(bytes.length!==r.bytes||createHash('sha256').update(bytes).digest('hex')!==r.sha256)return false;
   }
   if(['album','carousel','photo-post'].includes(v.format)&&(e.kind!=='post'||e.media.some(m=>m.type!=='image')))return false;
  }return true;
 }catch{return false;}
}
export async function deliverIntakeResults(app,{executeQueue=execute,getEntry=get,verify=verifyIntakeResult}={}){
 const unlock=lock(path.join(app.store.dir,'delivery.lock'),240000);if(!unlock)return{busy:true};
 const out={submitted:0,blocked:0,unknown:0};
 const mark=(id,channel,value)=>app.store.tx(s=>{const j=s.jobs[id];j.queueResults||={};j.queueResults[channel]={...value,at:new Date().toISOString()};return null;});
 try{
  for(const job of app.jobs()){
   const material=app.store.read().materials[job.materialId];
   if(job.status!=='completed'||!job.artifactsVerified||material?.revision!==job.revision||material.mode!=='submitted')continue;
   if(job.input?.timing?.mode==='choose_later'){out.blocked++;continue;}
   if(!verify(job.result,job)){out.blocked++;continue;}
   for(const variant of job.result.variants){
    // На каждом внешнем эффекте заново проверяем актуальность исходного задания.
    const current=app.store.read(),m=current.materials[job.materialId],j=current.jobs[job.id];
    if(m.revision!==job.revision||m.mode!=='submitted')break;
    const e=entryFromIntakeVariant(variant,job),hash=contentHash(e),prior=j.queueResults?.[e.channel];let queued=getEntry(e.id);
    if(queued&&queued.contentHash!==hash){out.blocked++;mark(job.id,e.channel,{status:'conflict',id:e.id});continue;}
    if(queued&&['review','approved','running','handed','published'].includes(queued.status)&&queued.approval?.card?.messageId){mark(job.id,e.channel,{status:'submitted',id:e.id,contentHash:hash});continue;}
    if(['sending','unknown','submitted'].includes(prior?.status)){out.unknown++;continue;}
    if(queued&&!['draft'].includes(queued.status)){out.blocked++;continue;}
    if(!queued){const added=await executeQueue('add',{entries:e},'intake');if(added.code!==0){out.blocked++;continue;}queued=getEntry(e.id);}
    if(!queued||queued.contentHash!==hash){out.blocked++;continue;}
    mark(job.id,e.channel,{status:'sending',id:e.id,contentHash:hash});
    try{
     const sent=await executeQueue('submit',{ref:e.id,channel:e.channel},'intake');queued=getEntry(e.id);
     if(sent.code===0&&queued?.contentHash===hash&&queued.approval?.card?.messageId&&['review','approved','running','published','handed'].includes(queued.status)){
      mark(job.id,e.channel,{status:'submitted',id:e.id,contentHash:hash});out.submitted++;
     }else{mark(job.id,e.channel,{status:'unknown',id:e.id,contentHash:hash});out.unknown++;}
    }catch{mark(job.id,e.channel,{status:'unknown',id:e.id,contentHash:hash});out.unknown++;}
   }
  }return out;
 }finally{unlock();}
}
