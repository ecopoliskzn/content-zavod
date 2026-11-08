// Сводка служебной карточки берётся из фактической очереди, а не из обещания редактора.
// Ручная передача не становится публикацией; завершённые комплекты освобождают квоту.
import {get} from '../queue/store.mjs';import {stopState,isHeld,isRestored} from '../queue/switch.mjs';
import {effectiveDue,requestedPeriodEnded} from '../queue/timing.mjs';
import {readJson} from '../lib/files.mjs';import {dataPath} from '../lib/env.mjs';
import {rows} from '../media/library.mjs';
const result=(passed,reason)=>({result:passed?'passed':'unknown',reason});
export function intakeQueueSummary(job,{getEntry=get,now=Date.now(),blocked=stopState().stopped||isHeld()||isRestored(),backup=readJson(dataPath('media-intake','backup-evidence.json'),null)}={}){
 const targets=(job.targets||[]).map(target=>{
  const ref=job.queueResults?.[target.channel],entry=ref?.id?getEntry(ref.id):null;
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
  for(const [p,stage]of Object.entries(stages))stage.evidence=stage.result==='passed'?[{evidence_id:`${job.id}:${target.channel}:${p}:${valid?entry.contentHash:job.inputHash}`,type:valid?'queue-snapshot':'validated-editor-artifacts',subject_id:valid?entry.id:job.id,input_revision:valid?entry.contentHash:job.inputHash,result:'passed',checked_at:new Date(now).toISOString(),checked_by:'intake-queue-sync',artifact_ref:valid?'queue:'+entry.id:'intake-job:'+job.id,receipt:valid?{status,card_id:entry.approval?.card?.messageId||null,approval_at:entry.approval?.at||null,started_at:entry.startedAt||null,attempts:entry.attempts||0,external_id:entry.result?.id||null,url:link}:null}]:[];
  return {channel:target.channel,id:valid?entry.id:null,contentHash:valid?entry.contentHash:null,status,link,date:valid?entry.date:null,time:valid?entry.time:null,timing_mode:valid?entry.timing?.mode:null,delivery_mode:target.delivery_mode,stages,closed,published,handed};
 });
 const workflowClosed=targets.length>0&&targets.every(t=>t.closed),publicationComplete=targets.length>0&&targets.every(t=>t.published);
 const outcome=publicationComplete?'published':workflowClosed?'closed-with-exceptions':targets.some(t=>t.published)?'partial':targets.some(t=>t.handed)?'handed':targets.some(t=>t.status==='review')?'review':targets.some(t=>t.status==='approved')?'approved':'blocked';
 const stages={};for(const p of ['P7','P8','P9','P10','P11','P12','P13'])stages[p]={result:targets.length&&targets.every(t=>t.stages[p].result==='passed')?'passed':'unknown',reason:'per-target-queue-evidence',evidence:targets.flatMap(t=>t.stages[p].evidence)};
 let independent=false;
 if(backup?.independentRussianCopyVerified===true&&backup.restoreVerified===true&&backup.artifact_ref&&Array.isArray(backup.coveredSha256)){
  const all=rows(),required=[...(job.input?.files||[]).map(f=>f.sha256),...(job.result?.variants||[]).flatMap(v=>(v.mediaIds||[]).map(id=>all.find(r=>r.mediaId===id)?.sha256))];
  const at=Date.parse(backup.checked_at),until=Date.parse(backup.expires_at);
  independent=Number.isFinite(at)&&at<=now+300000&&now-at<=24*3600000&&until>=now&&required.length>0&&required.every(sha=>/^[a-f0-9]{64}$/.test(sha||'')&&backup.coveredSha256.includes(sha));
 }
 stages.P14={result:independent?'passed':backup?.independentRussianCopyVerified===false?'blocked':'unknown',reason:independent?'independent-russian-restore-verified':'independent-backup-not-verified',artifact_ref:backup?.artifact_ref||null,evidence:independent?[{type:'external-backup-and-restore',subject_id:job.materialId,input_revision:job.revision,result:'passed',checked_at:backup.checked_at,checked_by:'S0',artifact_ref:backup.artifact_ref}]:[]};
 return {targets,stages,workflowClosed,publicationComplete,outcome};
}
export function syncIntakeQueue(app,options){
 const state=app.store.read(),changes=[];
 for(const job of Object.values(state.jobs)){
  const m=state.materials[job.materialId];if(!m||m.revision!==job.revision||job.status!=='completed')continue;
  const semantic=v=>JSON.stringify(v,(key,value)=>key==='checked_at'?undefined:value);
  const summary=intakeQueueSummary(job,options);if(semantic(m.queueSummary)!==semantic(summary))changes.push({id:m.id,jobId:job.id,revision:m.revision,summary});
 }
 if(changes.length)app.store.tx(s=>{for(const c of changes){const r=s.materials[c.id];if(r?.revision!==c.revision)continue;r.queueSummary=c.summary;r.workflowClosed=c.summary.workflowClosed;r.card.dirty=true;s.jobs[c.jobId].queueEvidence=c.summary.targets;}return null;});
 return{updated:changes.length};
}
