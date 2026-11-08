import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync} from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';import {intakeHostCycle} from '../ops/intake-dispatch-host.mjs';
test('один code cycle: пустой poll без LLM, новый job один queue и ни одного ложного accepted',async()=>{
 const folder=mkdtempSync(path.join(tmpdir(),'dispatch-host-'));let calls=0;const execute=async(exe,args)=>{calls++;return{code:0,stdout:''};};
 await intakeHostCycle({folder,sendEnabled:true,codex:'fake',metadata:async()=>[],execute,review:false});assert.equal(calls,0);
 const job={id:'a'.repeat(16),materialId:'b'.repeat(16),revision:1,inputHash:'c'.repeat(64),recipient:'S1',status:'queued',protocolVersion:2,manifestRevision:1},options={folder,sendEnabled:true,codex:'fake',metadata:async()=>[job],execute,review:false};
 await intakeHostCycle(options);await intakeHostCycle(options);assert.equal(calls,1);const state=JSON.parse(readFileSync(path.join(folder,'outbox.json')));assert.equal(Object.values(state)[0].status,'queued');
});
test('прежний review pending attempted не посылается снова и не ack по exit0',async()=>{
 const folder=mkdtempSync(path.join(tmpdir(),'dispatch-review-')),batchId='a'.repeat(64);let queue=0,begin=0;
 const execute=async(exe,args)=>{if(args[0]==='queue'){queue++;return{code:0,stdout:''};}if(args[1]?.startsWith('--begin=')){begin++;return{code:0,stdout:JSON.stringify({status:'SEND'})};}return{code:0,stdout:JSON.stringify({status:'EVENT',batchId,file:'private-batch.json',attempted:queue>0})};};
 const options={folder,sendEnabled:true,codex:'fake',metadata:async()=>[],execute};await intakeHostCycle(options);await intakeHostCycle(options);assert.equal(queue,1);assert.equal(begin,1);
});
test('два scoped job одного материала передаются по одному до реального завершения claim',async()=>{
 const folder=mkdtempSync(path.join(tmpdir(),'dispatch-single-material-'));let sends=0;
 const first={id:'a'.repeat(16),materialId:'b'.repeat(16),revision:2,inputHash:'c'.repeat(64),recipient:'S1',status:'queued',protocolVersion:2,manifestRevision:1},second={...first,id:'d'.repeat(16),revision:3};
 let jobs=[first,second];const options={folder,sendEnabled:true,codex:'fake',metadata:async()=>jobs,execute:async()=>{sends++;return{code:0,stdout:''};},review:false};
 await intakeHostCycle(options);await intakeHostCycle(options);assert.equal(sends,1);
 const state=JSON.parse(readFileSync(path.join(folder,'outbox.json'))),sent=Object.values(state).find(i=>i.status==='queued');
 jobs=[{...first,status:'claimed',acceptedClaims:[{requestId:sent.requestId,owner:'S1',initialInputHash:first.inputHash,at:new Date().toISOString()}]},second];await intakeHostCycle(options);assert.equal(sends,1);
 jobs[0].status='completed';await intakeHostCycle(options);assert.equal(sends,2);
});
