import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {claimIntakeJob} from '../src/bot/media-intake-cli.mjs';
import {refreshClaimContext,annotateClaimFacts} from '../src/bot/media-intake-cli.mjs';import {createIntake} from '../src/bot/media-intake.mjs';
test('успешный серверный claim и отказ локальной записи возобновляются одним requestId',async()=>{
 const folder=mkdtempSync(path.join(tmpdir(),'claim-recovery-')),id='a'.repeat(16),requests=[];let allocated;
 const invoke=async(cmd,args)=>{requests.push(args.requestId);if(!allocated)allocated={ok:true,token:'test-claim',job:{id},requestId:args.requestId};assert.equal(args.requestId,allocated.requestId);return allocated;};
 await assert.rejects(()=>claimIntakeJob(id,'S1',{folder,invoke,save:()=>{throw Error('disk');}}));
 const file=await claimIntakeJob(id,'S1',{folder,invoke});assert.equal(requests.length,2);assert.equal(requests[0],requests[1]);assert.equal(JSON.parse(readFileSync(file)).token,'test-claim');
 await claimIntakeJob(id,'S1',{folder,invoke});assert.equal(requests.length,2);await assert.rejects(()=>claimIntakeJob(id,'S2',{folder,invoke}));
});
test('CLI question → ответ автора → context → facts сохраняет новый inputHash для result',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'cli-context-')),config={enabled:true,groupId:'-100123',topicId:9,authors:['11'],coordinators:['22'],approvers:['33'],handoffMode:'B',targets:[{channel:'telegram',account_ref:'test',format:'album',delivery_mode:'auto',readiness:'passed',verified_at:'2026-11-07T10:00:00Z'}],limits:{maxFiles:10,maxBytes:100,maxPending:20,maxText:4000,maxJobInput:24000,maxJobOutput:24000,maxCalls:4},policyVersion:'test',quietMs:0};
 const app=createIntake({dir,config,importFile:async()=>({mediaId:'med_'+'a'.repeat(32),sha256:'a'.repeat(64),bytes:12,mime:'image/jpeg',verified:true,readable:true}),telegram:async()=>({ok:true,messageId:101}),verifyResult:()=>true});
 await app.handleUpdate({update_id:1,message:{message_id:1,chat:{id:-100123},message_thread_id:9,from:{id:11},caption:'Образец на фото.',photo:[{file_id:'file1',file_unique_id:'unique1',file_size:12}]}});
 const id=app.list()[0].id;app.edit(id,app.show(id).revision,'11',{rights:true});app.prepare(id,app.show(id).revision,'11');const job=app.jobs()[0];
 const invoke=async(cmd,a)=>cmd==='intake-claim'?app.claim(a.id,a.owner,a.requestId):cmd==='intake-context'?app.context(a.id,a.owner,a.token):app.facts(a.id,a.revision,a.jobId,a.owner,a.token,a.facts);
 const file=await claimIntakeJob(job.id,'S1',{folder:path.join(dir,'consumer'),invoke}),initial=JSON.parse(readFileSync(file));
 app.question(job.id,'S1',initial.token,{text:'Какая длина образца?'});await app.flush();
 await app.handleUpdate({update_id:2,message:{message_id:2,chat:{id:-100123},message_thread_id:9,from:{id:11},reply_to_message:{message_id:101},text:'Длина образца 40 мм.'}});
 const context=await refreshClaimContext(file,{invoke});assert.match(context.context.questions[0].answer,/40/);
 await annotateClaimFacts(file,{sources:[{id:'client-document',kind:'client-document',locator:'документ клиента: синтетический акт измерения',text:'Длина образца 40 мм.'}],facts:[{claim:'Длина образца 40 мм.',sourceId:'client-document',confirmed:true}],resolutions:[{questionId:context.context.questions[0].id,type:'source',sourceId:'client-document',claims:['Длина образца 40 мм.']}]},{invoke});
 const latest=JSON.parse(readFileSync(file));assert.notEqual(latest.job.inputHash,initial.job.inputHash);assert.equal(latest.job.inputHash,app.jobs()[0].inputHash);
 const value={inputHash:latest.job.inputHash,variants:[{channel:'telegram',format:'album',text:'Образец длиной 40 мм.',mediaIds:['test']}],editorialReview:{result:'passed',policyVersion:'test'}};
 assert.equal(app.result(job.id,'S1',latest.token,value).ok,true);
});
