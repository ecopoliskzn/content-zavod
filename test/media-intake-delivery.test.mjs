import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'intake-delivery-'));process.env.DATA_DIR=dir;process.env.ZAVOD_ENV_FILE=path.join(dir,'absent.env');
const {deliverIntakeResults}=await import('../src/bot/media-intake-delivery.mjs');
const {normalize,contentHash}=await import('../src/queue/format.mjs');
const {targetEntryName}=await import('../src/bot/media-intake-targets.mjs');
function fixture(){const job={id:'job1',materialId:'a'.repeat(16),revision:1,status:'completed',artifactsVerified:true,result:{variants:[{channel:'telegram',format:'album',entry:{channel:'telegram',kind:'post',name:'mi-'+ 'a'.repeat(16)+'-1',material:'intake:'+ 'a'.repeat(16),text:'Объект',media:[{type:'image',mediaId:'med_photo'}]}}]}};const state={jobs:{job1:job},materials:{[job.materialId]:{revision:1,mode:'submitted'}}};const entries=new Map(),calls=[];
 job.targets=[{channel:'telegram',format:'album'}];job.input={timing:{mode:'after_approval'},facts:[]};job.result.variants[0].text='Объект';
 const app={store:{dir,read:()=>structuredClone(state),tx:fn=>fn(state)},jobs:()=>Object.values(state.jobs)};
 const dependencies={verify:()=>true,getEntry:id=>entries.get(id),executeQueue:async(cmd,args)=>{calls.push(cmd);if(cmd==='add'){const e=normalize(args.entries);entries.set(e.id,{...e,contentHash:contentHash(e),status:'draft'});}if(cmd==='submit'){const e=entries.get(args.ref);e.status='review';e.approval={card:{messageId:123}};}return{code:0};}};return{app,state,entries,calls,dependencies};}
test('готовый результат передаётся штатным add/submit один раз и не одобряется',async()=>{
 const f=fixture();await deliverIntakeResults(f.app,f.dependencies);await deliverIntakeResults(f.app,f.dependencies);assert.deepEqual(f.calls,['add','submit']);const entry=[...f.entries.values()][0];assert.equal(entry.status,'review');assert.equal(entry.approval.at,undefined);assert.equal(f.state.jobs.job1.queueResults.telegram.status,'submitted');
});
test('choose_later остаётся ожиданием, модель не задаёт статус, срок и скрытый extra',async()=>{
 const f=fixture();f.state.jobs.job1.input.timing={mode:'choose_later'};await deliverIntakeResults(f.app,f.dependencies);assert.equal(f.calls.length,0);
 f.state.jobs.job1.input.timing={mode:'after_approval'};f.state.jobs.job1.result.variants[0].entry.extra={approved:true};await assert.rejects(()=>deliverIntakeResults(f.app,f.dependencies));assert.equal(f.calls.length,0);
});
test('изменившийся комплект и непроверенные производные не попадают в очередь',async()=>{
 const f=fixture();f.state.materials['a'.repeat(16)].revision=2;await deliverIntakeResults(f.app,f.dependencies);assert.equal(f.calls.length,0);
 f.state.materials['a'.repeat(16)].revision=1;await deliverIntakeResults(f.app,{...f.dependencies,verify:()=>false});assert.equal(f.calls.length,0);
});
test('падение после отправки карточки сначала сверяет очередь и не повторяет отправку',async()=>{
 const f=fixture();const e=normalize(f.state.jobs.job1.result.variants[0].entry);f.entries.set(e.id,{...e,status:'review',contentHash:contentHash(e),approval:{card:{messageId:123}}});f.state.jobs.job1.queueResults={telegram:{status:'sending',id:e.id}};
 await deliverIntakeResults(f.app,f.dependencies);assert.equal(f.calls.length,0);assert.equal(f.state.jobs.job1.queueResults.telegram.status,'submitted');
});
test('неопределённый внешний результат не повторяется вслепую',async()=>{
 const f=fixture();f.dependencies.executeQueue=async(cmd,args)=>{f.calls.push(cmd);if(cmd==='add'){const e=normalize(args.entries);f.entries.set(e.id,{...e,status:'draft',contentHash:contentHash(e)});return{code:0};}throw Error('timeout');};
 await deliverIntakeResults(f.app,f.dependencies);await deliverIntakeResults(f.app,f.dependencies);assert.deepEqual(f.calls,['add','submit']);assert.equal(f.state.jobs.job1.queueResults.telegram.status,'unknown');
});
test('смена ревизии во время add не отправляет устаревшую карточку',async()=>{
 const f=fixture(),execute=f.dependencies.executeQueue;
 f.dependencies.executeQueue=async(cmd,args)=>{const r=await execute(cmd,args);if(cmd==='add')f.state.materials['a'.repeat(16)].revision=2;return r;};
 await deliverIntakeResults(f.app,f.dependencies);assert.deepEqual(f.calls,['add']);
});
test('карточка иного хеша не восстанавливает квитанцию submitted',async()=>{
 const f=fixture(),e=normalize(f.state.jobs.job1.result.variants[0].entry);
 f.entries.set(e.id,{...e,status:'review',contentHash:contentHash(e),approval:{card:{messageId:123},cardHash:'other'}});
 f.state.jobs.job1.queueResults={telegram:{status:'unknown',id:e.id}};
 await deliverIntakeResults(f.app,f.dependencies);assert.equal(f.state.jobs.job1.queueResults.telegram.status,'unknown');assert.deepEqual(f.calls,[]);
});
test('protocol 2 сохраняет две квитанции Instagram и не повторяет отправку',async()=>{
 const f=fixture(),job=f.state.jobs.job1;job.protocolVersion=2;
 job.targets=[{channel:'instagram',format:'carousel'},{channel:'instagram',format:'story'}];
 job.result.variants=job.targets.map(t=>({ ...t,text:'Объект',entry:{channel:t.channel,kind:t.format,name:targetEntryName(job,t),material:`intake:${job.materialId}`,text:'Объект',media:Array.from({length:t.format==='carousel'?2:1},()=>({type:'image',mediaId:'med_photo'}))}}));
 const execute=f.dependencies.executeQueue;f.dependencies.executeQueue=async(cmd,args)=>{const r=await execute(cmd,args);if(cmd==='submit'){const e=f.entries.get(args.ref);e.approval.cardHash=e.contentHash;}return r;};
 await deliverIntakeResults(f.app,f.dependencies);await deliverIntakeResults(f.app,f.dependencies);
 assert.deepEqual(Object.keys(job.queueResults).sort(),['instagram:carousel','instagram:story']);assert.equal(f.entries.size,2);assert.equal(f.calls.filter(c=>c==='submit').length,2);
});
