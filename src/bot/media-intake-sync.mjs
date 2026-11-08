// Сводка служебной карточки берётся из фактической очереди, а не из обещания редактора.
// Ручная передача не становится публикацией; завершённые комплекты освобождают квоту.
import {get} from '../queue/store.mjs';import {stopState,isHeld,isRestored} from '../queue/switch.mjs';
import {effectiveDue,requestedPeriodEnded} from '../queue/timing.mjs';
import {readJson} from '../lib/files.mjs';import {dataPath} from '../lib/env.mjs';
import {rows} from '../media/library.mjs';
import {targetKey} from './media-intake-targets.mjs';
const result=(passed,reason)=>({result:passed?'passed':'unknown',reason});
export function intakeQueueSummary(job,{getEntry=get,mediaRows=rows,now=Date.now(),blocked=stopState().stopped||isHeld()||isRestored(),backup=readJson(dataPath('media-intake','backup-evidence.json'),null)}={}){
 const targets=(job.targets||[]).map(target=>{
  const key=targetKey(target),ref=job.queueResults?.[key]||(job.targets.filter(t=>t.channel===target.channel).length===1?job.queueResults?.[target.channel]:null),entry=ref?.id?getEntry(ref.id):null;
  const valid=Boolean(entry&&entry.contentHash===ref.contentHash&&entry.material==='intake:'+job.materialId);
  const status=valid?entry.status:'unknown',link=valid&&typeof entry.result?.link==='string'&&/^https:\/\//.test(entry.result.link)?entry.result.link:null;
  const approved=valid&&Boolean(entry.approval?.at)&&['approved','running','failed','expired','handed','published'].includes(status);
  const published=status==='published'&&Boolean(link),handed=status==='handed',closed=published||status==='cancelled';
  const preview=valid&&entry.approval?.card?.messageId&&entry.approval?.cardHash===entry.contentHash&&entry.approval?.preview?.complete;
  const attempted=valid&&Boolean(entry.startedAt&&entry.attempts>0);
  const preflight=(published||handed)||(approved&&attempted&&status==='running'&&!blocked&&!requestedPeriodEnded(entry,now)&&effectiveDue(entry,now)<=now);
  const stages={
   P7:result(job.artifactsVerified===true,'validated-editor-result'),P8:result(Boolean(preview),'complete-current-preview'),P9:result(approved,'actual-queue-approval'),
   P10:result(Boolean(preflight),'actual-release-preflight-or-confirmed-outcome'),P11:result(published||handed,'external-result-or-manual-handoff'),P12:result(published,handed?'manual-handoff-is-not-publication':'verified-publication-link'),P13:result(closed,'publication-or-explicit-cancellation')};
  for(const [p,stage]of Object.entries(stages))stage.evidence=stage.result==='passed'?[{evidence_id:`${job.id}:${key}:${p}:${valid?entry.contentHash:job.inputHash}`,type:valid?'queue-snapshot':'validated-editor-artifacts',subject_id:valid?entry.id:job.id,input_revision:valid?entry.contentHash:job.inputHash,result:'passed',checked_at:new Date(now).toISOString(),checked_by:'intake-queue-sync',artifact_ref:valid?'queue:'+entry.id:'intake-job:'+job.id,receipt:valid?{status,card_id:entry.approval?.card?.messageId||null,approval_at:entry.approval?.at||null,started_at:entry.startedAt||null,attempts:entry.attempts||0,external_id:entry.result?.id||null,url:link}:null}]:[];
  return {channel:target.channel,format:target.format,targetKey:key,id:valid?entry.id:null,contentHash:valid?entry.contentHash:null,status,link,date:valid?entry.date:null,time:valid?entry.time:null,timing_mode:valid?entry.timing?.mode:null,delivery_mode:target.delivery_mode,stages,closed,published,handed};
 });
 const workflowClosed=targets.length>0&&targets.every(t=>t.closed),publicationComplete=targets.length>0&&targets.every(t=>t.published);
 const outcome=publicationComplete?'published':workflowClosed?'closed-with-exceptions':targets.some(t=>t.published)?'partial':targets.some(t=>t.handed)?'handed':targets.some(t=>t.status==='review')?'review':targets.some(t=>t.status==='approved')?'approved':'blocked';
 const stages={};for(const p of ['P7','P8','P9','P10','P11','P12','P13'])stages[p]={result:targets.length&&targets.every(t=>t.stages[p].result==='passed')?'passed':'unknown',reason:'per-target-queue-evidence',evidence:targets.flatMap(t=>t.stages[p].evidence)};
 let independent=false;
 if(backup?.independentRussianCopyVerified===true&&backup.restoreVerified===true&&backup.artifact_ref&&Array.isArray(backup.coveredSha256)){
  const all=mediaRows(),required=[...(job.input?.files||[]).map(f=>f.sha256),...(job.result?.variants||[]).flatMap(v=>[...(v.mediaIds||[]),...(v.entry?.media||[]).map(m=>m.coverMediaId).filter(Boolean)].map(id=>all.find(r=>r.mediaId===id)?.sha256))];
  const at=Date.parse(backup.checked_at),until=Date.parse(backup.expires_at);
  const manifestRevision=job.manifestRevision||job.input?.manifestRevision;
  const coveredJob=Number.isSafeInteger(manifestRevision)&&manifestRevision>0&&Array.isArray(backup.coveredJobs)&&backup.coveredJobs.some(c=>c.jobId===job.id&&c.materialId===job.materialId&&c.revision===job.revision&&c.manifestRevision===manifestRevision&&/^[a-f0-9]{64}$/.test(c.inputHash||'')&&c.inputHash===job.inputHash);
  independent=Number.isFinite(at)&&at<=now+300000&&now-at<=24*3600000&&until>=now&&coveredJob&&required.every(sha=>/^[a-f0-9]{64}$/.test(sha||'')&&backup.coveredSha256.includes(sha));
 }
 stages.P14={result:independent?'passed':backup?.independentRussianCopyVerified===false?'blocked':'unknown',reason:independent?'independent-russian-restore-verified':'independent-backup-not-verified',artifact_ref:backup?.artifact_ref||null,evidence:independent?[{type:'external-backup-and-restore',subject_id:job.materialId,input_revision:job.revision,result:'passed',checked_at:backup.checked_at,checked_by:'S0',artifact_ref:backup.artifact_ref}]:[]};
 return {targets,stages,workflowClosed,publicationComplete,outcome};
}
export function syncIntakeQueue(app,options){
 // Замечание берётся самим core из доверенной очереди, не из аргументов модели.
 if(typeof app.queueFeedback==='function')for(const job of app.jobs())if(job.status==='completed')for(const t of job.targets||[]){
  if(!app.isCurrentTarget||app.isCurrentTarget(job.id,targetKey(t)))app.queueFeedback(job.id,targetKey(t));
 }
 const state=app.store.read(),changes=[];
 for(const m of Object.values(state.materials)){
  if(m.mode!=='submitted')continue;
  const jobs=Object.values(state.jobs).filter(j=>j.materialId===m.id),current=jobs.find(j=>j.revision===m.revision);
  if(!current&&!m.targetJobs)continue;
  const targets=m.targets||current?.targets||[],owners=m.targetJobs||Object.fromEntries(targets.map(t=>[targetKey(t),current.id]));
  const summaries=new Map(),selected=[];
  for(const t of targets){
   const key=targetKey(t),j=state.jobs[owners[key]];
   const job=j&&j.materialId===m.id&&j.targets.some(x=>targetKey(x)===key)?j:{id:'missing',materialId:m.id,revision:m.revision,targets:[t],artifactsVerified:false};
   if(!summaries.has(job.id))summaries.set(job.id,intakeQueueSummary(job,options));
   const part=summaries.get(job.id).targets.find(x=>x.targetKey===key);
   if(part)selected.push({...part,jobId:job.id,inputRevision:job.revision});
  }
  const workflowClosed=selected.length===targets.length&&selected.length>0&&selected.every(t=>t.closed),publicationComplete=selected.length===targets.length&&selected.length>0&&selected.every(t=>t.published);
  const stages={};for(const p of ['P7','P8','P9','P10','P11','P12','P13'])stages[p]={result:selected.length&&selected.every(t=>t.stages[p].result==='passed')?'passed':'unknown',reason:'current-target-jobs',evidence:selected.flatMap(t=>t.stages[p].evidence)};
  const backups=[...summaries.values()].map(s=>s.stages.P14);stages.P14={result:backups.length&&backups.every(b=>b.result==='passed')?'passed':backups.some(b=>b.result==='blocked')?'blocked':'unknown',reason:'all-current-target-jobs-backup-coverage',evidence:backups.flatMap(b=>b.evidence||[])};
  const outcome=publicationComplete?'published':workflowClosed?'closed-with-exceptions':selected.some(t=>t.published)?'partial':selected.some(t=>t.handed)?'handed':selected.some(t=>t.status==='review')?'review':selected.some(t=>t.status==='approved')?'approved':'blocked';
  const summary={targets:selected,stages,workflowClosed,publicationComplete,outcome};
  const semantic=v=>JSON.stringify(v,(key,value)=>key==='checked_at'?undefined:value);
  if(semantic(m.queueSummary)!==semantic(summary))changes.push({id:m.id,revision:m.revision,ownerMap:JSON.stringify(m.targetJobs),summary});
 }
 if(changes.length)app.store.tx(s=>{for(const c of changes){const r=s.materials[c.id];if(r?.revision!==c.revision||JSON.stringify(r.targetJobs)!==c.ownerMap)continue;r.queueSummary=c.summary;r.workflowClosed=c.summary.workflowClosed;r.card.dirty=true;for(const t of c.summary.targets){const j=s.jobs[t.jobId];if(j)j.queueEvidence=c.summary.targets.filter(x=>x.jobId===j.id);}}return null;});
 return{updated:changes.length};
}
