// Событийная передача метаданных редактору: пустой опрос не вызывает модель.
// Неизвестная отправка не повторяется. Приём подтверждает серверный claim,
// включая исходный хеш, который не меняется после уточнения фактов редактором.
import {createHash} from 'node:crypto';
const hex=(v,n)=>typeof v==='string'&&new RegExp(`^[a-f0-9]{${n}}$`).test(v);
export function dispatchMetadata(j){
 if(!hex(j?.id,16)||!hex(j.materialId,16)||!hex(j.inputHash,64)||!Number.isSafeInteger(j.revision)||j.revision<1||!['S1','S2'].includes(j.recipient)||j.protocolVersion!==2)return null;
 const c=j.continuation,continuation=c?.kind==='answer'&&c.jobId===j.id&&c.materialId===j.materialId&&c.revision===j.revision&&c.recipient===j.recipient&&hex(c.requestId,32)&&hex(c.answerHash,64)&&Number.isSafeInteger(c.answerRevision)&&c.answerRevision>0?{kind:'answer',requestId:c.requestId,answerRevision:c.answerRevision,answerHash:c.answerHash}:null;
 return{id:j.id,materialId:j.materialId,revision:j.revision,inputHash:j.inputHash,status:j.status,recipient:j.recipient,protocolVersion:2,manifestRevision:j.manifestRevision,continuation,claimFencingVersion:j.claimFencingVersion===1?1:0,acceptedClaimsComplete:j.acceptedClaimsComplete===true,acceptedClaims:(j.acceptedClaims||[]).filter(c=>hex(c.requestId,32)&&hex(c.initialInputHash,64)&&['S1','S2'].includes(c.owner)&&Number.isFinite(Date.parse(c.at))).map(({requestId,initialInputHash,owner,at})=>({requestId,initialInputHash,owner,at}))};
}
export function reconcileIntakeDispatch(previous,jobs,acknowledgements=[]){
 const state=structuredClone(previous),metadata=jobs.map(dispatchMetadata).filter(Boolean);
 for(const item of Object.values(state)){
  const job=metadata.find(j=>j.id===item.jobId&&j.materialId===item.materialId&&j.revision===item.revision);
  if(item.kind==='answer'){
   const ack=acknowledgements.find(a=>a.dispatchId===item.dispatchId&&a.jobId===item.jobId&&a.requestId===item.requestId&&a.answerHash===item.answerHash&&a.answerRevision===item.answerRevision&&a.owner===item.owner&&Number.isFinite(Date.parse(a.at)));
   if(ack){item.status='accepted';item.acceptedAt=ack.at;continue;}
   if(item.status==='sending')item.status='unknown';
   if(job?.continuation?.answerRevision>item.answerRevision||!job||job.status!=='claimed')item.status=item.status==='accepted'?'accepted':'cancelled';
   continue;
  }
  const accepted=job?.acceptedClaims.find(c=>c.requestId===item.requestId&&c.owner===item.owner&&c.initialInputHash===item.inputHash);
  if(accepted){item.status='accepted';item.acceptedAt=accepted.at;continue;}
  if(item.status==='sending')item.status='unknown';
  if(['queued','unknown'].includes(item.status)&&job?.status==='queued'&&job.inputHash!==item.inputHash&&job.claimFencingVersion===1&&job.acceptedClaimsComplete){item.status='cancelled';item.reason='stale-identity-fenced-before-claim';}
  if(item.status==='planned'&&(!job||job.status!=='queued'||job.inputHash!==item.inputHash))item.status='cancelled';
 }
 for(const job of metadata){
  const c=job.continuation;
  if(job.status==='claimed'&&c){
   const dispatchId=createHash('sha256').update(JSON.stringify(['answer',job.id,job.revision,c.answerRevision,c.answerHash])).digest('hex');
   state[dispatchId]||={schema:1,kind:'answer',dispatchId,requestId:c.requestId,jobId:job.id,materialId:job.materialId,revision:job.revision,inputHash:job.inputHash,owner:job.recipient,protocolVersion:2,manifestRevision:job.manifestRevision,answerRevision:c.answerRevision,answerHash:c.answerHash,status:'planned'};
  }
  if(job.status!=='queued'||Object.values(state).some(s=>s.jobId===job.id&&s.revision===job.revision&&s.status!=='cancelled'))continue;
  const dispatchId=createHash('sha256').update(JSON.stringify([job.id,job.materialId,job.revision,job.inputHash,job.recipient])).digest('hex');
  if(state[dispatchId])continue;
  state[dispatchId]={schema:1,dispatchId,requestId:dispatchId.slice(0,32),jobId:job.id,materialId:job.materialId,revision:job.revision,inputHash:job.inputHash,owner:job.recipient,protocolVersion:2,manifestRevision:job.manifestRevision,status:'planned'};
 }
 return state;
}
export async function sendIntakeDispatch(state,id,{save,send}){
 const item=state[id];if(!item||item.status!=='planned')return false;
 item.status='sending';save(state); // Долговечный intent обязан предшествовать внешнему эффекту.
 try{item.status=await send({...item})===true?'queued':'unknown';}catch{item.status='unknown';}
 save(state);return true;
}
