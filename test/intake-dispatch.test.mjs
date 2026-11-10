import test from 'node:test';import assert from 'node:assert/strict';
import {reconcileIntakeDispatch,sendIntakeDispatch} from '../ops/intake-dispatch.mjs';
const job={id:'a'.repeat(16),materialId:'b'.repeat(16),revision:1,inputHash:'c'.repeat(64),status:'queued',current:true,recipient:'S1',protocolVersion:2,manifestRevision:1};
test('пустой poll не будит редактора; queued не равно accepted, повторного send нет',async()=>{
 assert.deepEqual(reconcileIntakeDispatch({},[]),{});
 let state=reconcileIntakeDispatch({},[job]),item=Object.values(state)[0],calls=0,saves=[];
 await sendIntakeDispatch(state,item.dispatchId,{save:s=>saves.push(structuredClone(s)),send:async()=>{calls++;return true;}});
 assert.equal(calls,1);assert.equal(saves[0][item.dispatchId].status,'sending');assert.equal(state[item.dispatchId].status,'queued');
 await sendIntakeDispatch(state,item.dispatchId,{save:()=>{},send:async()=>{calls++;}});assert.equal(calls,1);
});
test('неопределённая отправка и рестарт не повторяются, claim переживает facts/completed/release',async()=>{
 let state=reconcileIntakeDispatch({},[job]),item=Object.values(state)[0];
 await sendIntakeDispatch(state,item.dispatchId,{save:()=>{},send:async()=>{throw Error('lost');}});assert.equal(state[item.dispatchId].status,'unknown');
 const accepted={requestId:item.requestId,owner:'S1',initialInputHash:job.inputHash,at:'2026-11-08T12:00:00Z'};
 for(const status of ['claimed','completed','queued']){
  const next=reconcileIntakeDispatch(state,[{...job,status,inputHash:'d'.repeat(64),acceptedClaims:[accepted]}]);assert.equal(next[item.dispatchId].status,'accepted');assert.equal(Object.keys(next).length,1);
 }
 const recovered=reconcileIntakeDispatch({...state,[item.dispatchId]:{...item,status:'sending'}},[job]);assert.equal(recovered[item.dispatchId].status,'unknown');
});
test('чужая квитанция/роль/хеш не подтверждают приём, новая ревизия отменяет только неотправленное',()=>{
 const state=reconcileIntakeDispatch({},[job]),item=Object.values(state)[0];
 for(const receipt of [{requestId:'e'.repeat(32),owner:'S1',initialInputHash:job.inputHash},{requestId:item.requestId,owner:'S2',initialInputHash:job.inputHash},{requestId:item.requestId,owner:'S1',initialInputHash:'f'.repeat(64)}])assert.notEqual(reconcileIntakeDispatch(state,[{...job,status:'completed',acceptedClaims:[receipt]}])[item.dispatchId].status,'accepted');
 assert.equal(reconcileIntakeDispatch(state,[{...job,revision:2}])[item.dispatchId].status,'cancelled');
});
test('retime до claim: stale queued/unknown меняются только по полной fenced-сверке, без захвата',()=>{
 const state=reconcileIntakeDispatch({},[job]),item=Object.values(state)[0],changed={...job,inputHash:'f'.repeat(64)};
 for(const status of ['queued','unknown']){
  const old={...state,[item.dispatchId]:{...item,status}};
  assert.equal(Object.keys(reconcileIntakeDispatch(old,[changed])).length,1);
  const next=reconcileIntakeDispatch(old,[{...changed,claimFencingVersion:1,acceptedClaimsComplete:true}]);
  assert.equal(next[item.dispatchId].status,'cancelled');assert.equal(Object.values(next).filter(i=>i.status==='planned').length,1);
 }
});
test('ответ на вопрос будит прежнего владельца один раз без нового claim и нового queued job',()=>{
 const continuation={kind:'answer',jobId:job.id,materialId:job.materialId,revision:1,recipient:'S1',requestId:'f'.repeat(32),answerRevision:1,answerHash:'e'.repeat(64)};
 const pending={...job,status:'claimed',continuation},state=reconcileIntakeDispatch({},[pending]),item=Object.values(state)[0];
 assert.equal(item.kind,'answer');assert.equal(item.requestId,continuation.requestId);assert.equal(Object.keys(reconcileIntakeDispatch(state,[pending])).length,1);
 const ack={dispatchId:item.dispatchId,jobId:job.id,requestId:item.requestId,owner:'S1',answerRevision:1,answerHash:continuation.answerHash,at:'2026-11-08T12:00:00Z'};
 assert.equal(reconcileIntakeDispatch(state,[{...pending,status:'completed'}],[ack])[item.dispatchId].status,'accepted');
 const changed={...pending,continuation:{...continuation,answerRevision:2,answerHash:'d'.repeat(64)}};
 const next=reconcileIntakeDispatch(state,[changed]);assert.equal(next[item.dispatchId].status,'cancelled');assert.equal(Object.values(next).filter(i=>i.status==='planned').length,1);
});
test('старый queued после общего изменения освобождает очередь только с fenced-current=false',()=>{
 const state=reconcileIntakeDispatch({},[job]),item=Object.values(state)[0],old={...state,[item.dispatchId]:{...item,status:'unknown'}},nextJob={...job,id:'e'.repeat(16),revision:2};
 const next=reconcileIntakeDispatch(old,[{...job,current:false,claimFencingVersion:1,acceptedClaimsComplete:true},nextJob]);
 assert.equal(next[item.dispatchId].status,'cancelled');assert.equal(Object.values(next).filter(i=>i.status==='planned').length,1);
 assert.equal(Object.keys(reconcileIntakeDispatch({},[{...job,current:false}])).length,0);
 assert.equal(Object.keys(reconcileIntakeDispatch({},[{...job,current:undefined}])).length,0);
 const receipt={requestId:item.requestId,owner:'S1',initialInputHash:job.inputHash,at:'2026-11-10T09:00:00Z'};
 assert.equal(reconcileIntakeDispatch(old,[{...job,current:false,claimFencingVersion:1,acceptedClaimsComplete:true,acceptedClaims:[receipt]}])[item.dispatchId].status,'accepted');
 assert.equal(reconcileIntakeDispatch(old,[{...job,current:false,claimFencingVersion:1,acceptedClaimsComplete:false}])[item.dispatchId].status,'unknown');
});
