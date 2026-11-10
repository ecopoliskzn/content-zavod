import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';
import {intakeWatchCycle,intakeWatchTransition} from '../ops/intake-watch.mjs';
const job={id:'a'.repeat(16),materialId:'b'.repeat(16),revision:1,inputHash:'c'.repeat(64),recipient:'S1',status:'queued',current:true,protocolVersion:2,manifestRevision:1};
test('native watcher планирует один fenced конверт, exit/tool ACK не равен серверному claim; неизвестное не повторяется',async()=>{
 const folder=mkdtempSync(path.join(tmpdir(),'intake-watch-')),metadata=async()=>[job],health=async()=>({unknownCards:0,failedFiles:0,blockedEvents:0}),o={folder,metadata,health};const event=await intakeWatchCycle(o);assert.equal(event.status,'EVENT');
 assert.equal(intakeWatchTransition(event.dispatchId,'begin',{folder}).status,'SEND');assert.equal(intakeWatchTransition(event.dispatchId,'begin',{folder}).status,'RECONCILE');assert.equal((await intakeWatchCycle(o)).status,'NO_CHANGE');
 intakeWatchTransition(event.dispatchId,'queued',{folder});assert.equal((await intakeWatchCycle(o)).status,'NO_CHANGE');
 const receipt={requestId:event.requestId,owner:'S1',initialInputHash:job.inputHash,at:new Date().toISOString()};const after=await intakeWatchCycle({...o,metadata:async()=>[{...job,status:'claimed',acceptedClaims:[receipt]}]});assert.equal(after.accepted,1);
});
test('сбой API/карточки виден один раз, восстановление не приводит к пустой передаче модели',async()=>{
 const folder=mkdtempSync(path.join(tmpdir(),'intake-watch-error-')),o={folder,metadata:async()=>{throw Error('private failure');},health:async()=>({})};assert.equal((await intakeWatchCycle(o)).status,'ERROR');assert.equal((await intakeWatchCycle(o)).status,'NO_CHANGE');
 assert.equal((await intakeWatchCycle({...o,metadata:async()=>[],health:async()=>({unknownCards:1})})).status,'ERROR');assert.equal((await intakeWatchCycle({...o,metadata:async()=>[],health:async()=>({unknownCards:0})})).status,'NO_CHANGE');
});
test('один неисправный материал не удерживает новые исправные задания после уведомления',async()=>{
 const folder=mkdtempSync(path.join(tmpdir(),'intake-watch-isolation-')),o={folder,metadata:async()=>[job],health:async()=>({failedFiles:1})};assert.equal((await intakeWatchCycle(o)).status,'ERROR');assert.equal((await intakeWatchCycle(o)).status,'EVENT');
});
