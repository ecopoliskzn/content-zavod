// Подготовленные варианты попадают только в штатную очередь и на обычное согласование.
// Квитанции связывают job с точной записью. Неизвестный исход отправки сначала сверяется.
import {existsSync,readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import path from 'node:path';
import {lock} from '../lib/files.mjs';import {rows,blobPath} from '../media/library.mjs';
import {execute} from '../queue/commands.mjs';import {get} from '../queue/store.mjs';
import {normalize,validate,contentHash} from '../queue/format.mjs';import {check} from '../gates/index.mjs';
import {mskDate,mskTime} from '../lib/time.mjs';
import {targetKey,targetEntryName,targetSpec} from './media-intake-targets.mjs';
/** Транспортные поля задаёт код по заданию; модель поставляет только содержимое. */
export function entryFromIntakeVariant(v,job){
 const target=job.targets.find(t=>targetKey(t)===targetKey(v)),spec=targetSpec(target);
 if(!target||!spec||typeof v.text!=='string'||!v.text.trim())throw Error('target');
 const raw=v.entry||{};
 if(raw.text!==v.text||Object.keys(raw).some(k=>!['channel','kind','name','material','title','text','posts','media','facts','date','time','tags','hashtags','series'].includes(k)))throw Error('payload');
 const name=targetEntryName(job,target);
 if(raw.channel!==v.channel||raw.kind!==spec.kind||raw.name!==name||raw.material!==`intake:${job.materialId}`)throw Error('identity');
 const facts=job.input.targetFacts?.[targetKey(target)]||job.input.targetFacts?.[v.channel]||job.input.facts||[],media=raw.media||[];
 if(JSON.stringify(raw.facts||[])!==JSON.stringify(facts)||!Array.isArray(media)||media.some(m=>Object.keys(m).some(k=>!['type','mediaId','coverMediaId'].includes(k))||!m.mediaId||!['image','video'].includes(m.type)||m.coverMediaId&&m.type!=='video'))throw Error('media_or_facts');
 if(spec.min&&media.length<spec.min||spec.max&&media.length>spec.max||spec.media==='none'&&media.length||spec.media==='video'&&media.some(m=>m.type!=='video')||['image','optional-image'].includes(spec.media)&&media.some(m=>m.type!=='image'))throw Error('media_format');
 if(v.channel==='instagram'&&v.text.length>2200)throw Error('caption');
 const t=job.input.timing||{mode:'after_approval'},at=t.at?Date.parse(t.at):Date.now();
 let timing;
 if(t.mode==='after_approval'||t.mode==='choose_later')timing={mode:'after-approval'};
 else if(t.mode==='not_before')timing={mode:'not-before',date:mskDate(at),time:mskTime(at),notBefore:t.at};
 else if(t.mode==='at'){
  const limits=[Math.floor(at/60000)*60000+59999,...[t.expireAt,t.deadline].filter(x=>x!==undefined).map(x=>Date.parse(x))];
  if(limits.some(x=>!Number.isFinite(x)))throw Error('timing');
  timing={mode:'at',date:mskDate(at),time:mskTime(at),atISO:t.at,expireAt:new Date(Math.min(...limits)).toISOString()};
 }
 else throw Error('timing');
 return normalize({...raw,channel:v.channel,kind:spec.kind,name,material:`intake:${job.materialId}`,text:v.text,media:media.map(m=>({...m})),facts,date:mskDate(at),time:mskTime(at),timing});
}
export function verifyIntakeResult(value,job){
 try{
  if(value?.inputHash!==job.inputHash||value.editorialReview?.result!=='passed'||value.editorialReview.policyVersion!==job.input?.policyVersion||!Array.isArray(value.variants)||value.variants.length!==job.targets.length)return false;
  const all=rows(),originals=new Set(job.input.files.map(f=>f.mediaId)),seen=new Set();
  for(const v of value.variants){
   const key=targetKey(v),target=job.targets.find(t=>targetKey(t)===key);if(!target||seen.has(key))return false;seen.add(key);
   // Новый manifest закрепляет выбор отдельно для каждого формата. Только
   // legacy без targetMedia использует общий состав исходников задания.
   const selection=job.input.targetMedia===undefined?[...originals]:job.input.targetMedia?.[key];
   if(!Array.isArray(selection)||selection.some(id=>!originals.has(id)))return false;
   const selected=new Set(selection);
   const e=entryFromIntakeVariant(v,job);if(validate(e).length||check(e).block.length)return false;
   if(!Array.isArray(v.mediaIds)||e.media.some(m=>m.url||m.cover)||e.media.length!==v.mediaIds.length)return false;
   for(let i=0;i<e.media.length;i++){
    const m=e.media[i],r=all.find(r=>r.mediaId===m.mediaId);
    if(m.mediaId!==v.mediaIds[i]||!r||r.role!=='publication'||!selected.has(r.parent)||r.material!==e.material||!existsSync(blobPath(r)))return false;
    if((m.type==='image'&&!r.mime.startsWith('image/'))||(m.type==='video'&&!r.mime.startsWith('video/')))return false;
    const bytes=readFileSync(blobPath(r));if(bytes.length!==r.bytes||createHash('sha256').update(bytes).digest('hex')!==r.sha256)return false;
    const source=job.input.files.find(f=>f.mediaId===r.parent),original=all.find(f=>f.mediaId===r.parent);
    if(!source||!original||original.role!=='original'||original.material!==e.material||source.sha256&&source.sha256!==original.sha256||source.bytes!==undefined&&source.bytes!==original.bytes||original.mime?.split('/')[0]!==m.type||source.mime&&source.mime.split('/')[0]!==m.type)return false;
    if(m.coverMediaId){const cover=all.find(f=>f.mediaId===m.coverMediaId);if(!cover||!['publication','cover'].includes(cover.role)||!selected.has(cover.parent)||cover.parent!==r.parent||cover.material!==e.material||!cover.mime.startsWith('image/')||!existsSync(blobPath(cover)))return false;const b=readFileSync(blobPath(cover));if(b.length!==cover.bytes||createHash('sha256').update(b).digest('hex')!==cover.sha256)return false;}
   }
  }return true;
 }catch{return false;}
}
export async function deliverIntakeResults(app,{executeQueue=execute,getEntry=get,verify=verifyIntakeResult}={}){
 const unlock=lock(path.join(app.store.dir,'delivery.lock'),240000);if(!unlock)return{busy:true};
 const out={submitted:0,blocked:0,unknown:0};
 // При точечной доработке старая общая ревизия ещё владеет неизменёнными
 // целями. Решение принимает intake; legacy без метода требует точной ревизии.
 const currentTarget=(job,key)=>{
  const state=app.store.read(),m=state.materials[job.materialId],j=state.jobs[job.id];
  if(!m||m.mode!=='submitted'||j?.status!=='completed'||!j.artifactsVerified||j.inputHash!==job.inputHash||JSON.stringify(j.result)!==JSON.stringify(job.result))return false;
  return typeof app.isCurrentTarget==='function'?app.isCurrentTarget(job.id,key)===true:m.revision===job.revision;
 };
 const mark=(id,channel,value)=>app.store.tx(s=>{const j=s.jobs[id];j.queueResults||={};j.queueResults[channel]={...value,at:new Date().toISOString()};return null;});
 try{
  for(const job of structuredClone(app.jobs())){
   if(job.status!=='completed'||!job.artifactsVerified||!job.targets.some(t=>currentTarget(job,targetKey(t))))continue;
   if(job.input?.timing?.mode==='choose_later'){out.blocked++;continue;}
   if(!verify(job.result,job)){out.blocked++;continue;}
   for(const variant of [...job.result.variants].sort((a,b)=>Number(b.channel==='youtube')-Number(a.channel==='youtube'))){
    // На каждом внешнем эффекте заново проверяем актуальность исходного задания.
    if(!currentTarget(job,targetKey(variant)))continue;
    const j=app.store.read().jobs[job.id];
    const e=entryFromIntakeVariant(variant,job),key=job.protocolVersion===2||job.targets.filter(t=>t.channel===e.channel).length>1?targetKey(variant):e.channel,hash=contentHash(e),prior=j.queueResults?.[key];let queued=getEntry(e.id);
    if(queued&&queued.contentHash!==hash){out.blocked++;mark(job.id,key,{status:'conflict',id:e.id});continue;}
    if(queued&&['review','approved','running','handed','published'].includes(queued.status)&&queued.approval?.card?.messageId&&(queued.approval.cardHash===hash||!job.protocolVersion&&!queued.approval.cardHash)){mark(job.id,key,{status:'submitted',id:e.id,contentHash:hash});continue;}
    if(['sending','unknown','submitted'].includes(prior?.status)){out.unknown++;continue;}
    if(queued&&!['draft'].includes(queued.status)){out.blocked++;continue;}
    if(!queued){if(!currentTarget(job,targetKey(variant))){out.blocked++;continue;}const added=await executeQueue('add',{entries:e},'intake');if(added.code!==0){out.blocked++;continue;}queued=getEntry(e.id);}
    if(!queued||queued.contentHash!==hash){out.blocked++;continue;}
    if(!currentTarget(job,targetKey(variant))){out.blocked++;continue;}
    mark(job.id,key,{status:'sending',id:e.id,contentHash:hash});
    try{
     const sent=await executeQueue('submit',{ref:e.id,channel:e.channel},'intake');queued=getEntry(e.id);
     if(sent.code===0&&queued?.contentHash===hash&&queued.approval?.card?.messageId&&(queued.approval.cardHash===hash||!job.protocolVersion&&!queued.approval.cardHash)&&['review','approved','running','published','handed'].includes(queued.status)){
      mark(job.id,key,{status:'submitted',id:e.id,contentHash:hash});out.submitted++;
     }else{mark(job.id,key,{status:'unknown',id:e.id,contentHash:hash});out.unknown++;}
    }catch{mark(job.id,key,{status:'unknown',id:e.id,contentHash:hash});out.unknown++;}
   }
  }return out;
 }finally{unlock();}
}
