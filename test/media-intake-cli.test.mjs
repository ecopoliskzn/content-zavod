import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {claimIntakeJob} from '../src/bot/media-intake-cli.mjs';
import {refreshClaimContext,annotateClaimFacts,submitClaimResult,acceptDispatchEnvelope,claimCurrentIntakeJob} from '../src/bot/media-intake-cli.mjs';import {createIntake} from '../src/bot/media-intake.mjs';
import {writeFileSync} from 'node:fs';
test('accept передаёт fencing identity серверу до claim; устаревший конверт не принимает задание',async()=>{
 const folder=mkdtempSync(path.join(tmpdir(),'envelope-fence-')),envelope={schema:1,dispatchId:'a'.repeat(64),requestId:'a'.repeat(32),jobId:'b'.repeat(16),materialId:'c'.repeat(16),revision:1,inputHash:'d'.repeat(64),protocolVersion:2,manifestRevision:1,owner:'S1'};let invoked=0;
 await assert.rejects(()=>acceptDispatchEnvelope(envelope,{folder,invoke:async(cmd,args)=>{invoked++;assert.deepEqual(args.expected,{materialId:envelope.materialId,revision:1,inputHash:envelope.inputHash,protocolVersion:2,manifestRevision:1});return{ok:false,reason:'stale'};}}));
 assert.equal(invoked,1);
});

test('result привязывает прочитанные claims к закрытым sources и отвергает старый hash',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'result-bind-')),file=path.join(dir,'claim.json'),fact={claim:'Поверхность пористая.',source:'интервью: закрытая атрибуция'},job={id:'a'.repeat(16),inputHash:'b'.repeat(64),input:{facts:[fact]}};
 writeFileSync(file,JSON.stringify({schema:1,owner:'S1',token:'closed',job}));let submitted;
 const invoke=async(cmd,a)=>cmd==='intake-context'?{ok:true,revision:1,job}:(submitted=a.result,{ok:true});
 const value={inputHash:job.inputHash,variants:[{channel:'telegram',format:'post',factRefs:[fact.claim],entry:{text:'Поверхность пористая.'}}]};
 await submitClaimResult(file,value,{invoke});assert.deepEqual(submitted.variants[0].entry.facts,[fact]);assert.equal(submitted.variants[0].factRefs,undefined);
 await assert.rejects(()=>submitClaimResult(file,{...value,inputHash:'c'.repeat(64)},{invoke}));
 await assert.rejects(()=>submitClaimResult(file,{...value,variants:[{...value.variants[0],factRefs:[]}]},{invoke}));
});
test('result success с потерей ответа повторяется точным intent без context completed и второго эффекта',async()=>{
 const folder=mkdtempSync(path.join(tmpdir(),'result-recovery-')),file=path.join(folder,'claim.json'),job={id:'a'.repeat(16),inputHash:'b'.repeat(64),input:{facts:[]}};writeFileSync(file,JSON.stringify({schema:1,owner:'S1',token:'closed',job}));
 let completed=false,effects=0,contexts=0;
 const invoke=async(cmd,a)=>{if(cmd==='intake-context'){contexts++;assert.equal(completed,false);return{ok:true,revision:1,job};}if(completed)return{ok:true,duplicate:true};completed=true;effects++;throw Error('response lost');};
 const value={inputHash:job.inputHash,variants:[{channel:'telegram',format:'post',factRefs:[],entry:{text:'Синтетический текст.'}}]};
 await assert.rejects(()=>submitClaimResult(file,value,{invoke}));assert.equal((await submitClaimResult(file,value,{invoke})).duplicate,true);assert.equal(contexts,1);assert.equal(effects,1);
 await assert.rejects(()=>submitClaimResult(file,{...value,variants:[]},{invoke}));assert.equal(effects,1);
});
test('ручной B claim использует свежую metadata и expected, не отключает fencing',async()=>{
 const folder=mkdtempSync(path.join(tmpdir(),'manual-fenced-')),id='a'.repeat(16),job={id,materialId:'b'.repeat(16),revision:2,inputHash:'c'.repeat(64),protocolVersion:2,manifestRevision:1,recipient:'S1'},calls=[];
 await claimCurrentIntakeJob(id,'S1',{folder,invoke:async(cmd,args)=>{calls.push(cmd);if(cmd==='intake-jobs')return[job];assert.equal(args.expected.inputHash,job.inputHash);assert.equal(args.expected.revision,2);return{ok:true,token:'closed',job};}});assert.deepEqual(calls,['intake-jobs','intake-claim']);
});
test('dispatcher requestId сохраняется до сети и иной dispatch не получает старую квитанцию',async()=>{
 const folder=mkdtempSync(path.join(tmpdir(),'dispatch-claim-')),id='b'.repeat(16),requestId='c'.repeat(32),seen=[];
 const invoke=async(cmd,a)=>{seen.push(a.requestId);return{ok:true,token:'test',job:{id}};};
 const file=await claimIntakeJob(id,'S1',{folder,invoke,requestId});assert.equal(seen[0],requestId);assert.equal(JSON.parse(readFileSync(file)).requestId,requestId);
 await assert.rejects(()=>claimIntakeJob(id,'S1',{folder,invoke,requestId:'d'.repeat(32)}));
});
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
