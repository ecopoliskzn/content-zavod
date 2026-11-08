import test from 'node:test';import assert from 'node:assert/strict';import {intakeQueueSummary,syncIntakeQueue} from '../src/bot/media-intake-sync.mjs';
const job={materialId:'case',artifactsVerified:true,targets:[{channel:'telegram',delivery_mode:'auto'},{channel:'vk',delivery_mode:'manual'}],queueResults:{telegram:{id:'tg',contentHash:'h1'},vk:{id:'vk',contentHash:'h2'}}};
const entry=(id,hash,status,link)=>({id,material:'intake:case',contentHash:hash,status,approval:{at:'2026-11-07T10:00:00Z',cardHash:hash,card:{messageId:1},preview:{complete:true}},result:{link}});
test('частичный выпуск и ручная передача не закрывают workflow и не проходят P12',()=>{
 const data={tg:entry('tg','h1','published','https://t.me/test/1'),vk:entry('vk','h2','handed')};const summary=intakeQueueSummary(job,{getEntry:id=>data[id],blocked:false,backup:null});
 assert.equal(summary.outcome,'partial');assert.equal(summary.workflowClosed,false);assert.equal(summary.publicationComplete,false);assert.equal(summary.targets[0].stages.P12.result,'passed');assert.equal(summary.targets[1].stages.P12.result,'unknown');assert.equal(summary.stages.P14.result,'unknown');
});
test('фактические ссылки закрывают workflow; отмена даёт итог с исключением; backup требует restore',()=>{
 const data={tg:entry('tg','h1','published','https://t.me/test/1'),vk:entry('vk','h2','published','https://vk.com/wall-1_2')};
 let summary=intakeQueueSummary(job,{getEntry:id=>data[id],blocked:false,backup:{independentRussianCopyVerified:true,restoreVerified:false}});assert.equal(summary.publicationComplete,true);assert.equal(summary.workflowClosed,true);assert.equal(summary.stages.P9.result,'passed');assert.notEqual(summary.stages.P14.result,'passed');
 data.vk.status='cancelled';summary=intakeQueueSummary(job,{getEntry:id=>data[id],blocked:false,backup:null});assert.equal(summary.workflowClosed,true);assert.equal(summary.publicationComplete,false);assert.equal(summary.outcome,'closed-with-exceptions');
});
test('два формата одного канала требуют отдельных квитанций и evidence id',()=>{
 const multi={...job,id:'job',protocolVersion:2,targets:[{channel:'instagram',format:'carousel'},{channel:'instagram',format:'story'}],queueResults:{'instagram:carousel':{id:'one',contentHash:'h1'},'instagram:story':{id:'two',contentHash:'h2'}}};
 const summary=intakeQueueSummary(multi,{getEntry:id=>entry(id,id==='one'?'h1':'h2',id==='one'?'published':'review','https://instagram.com/p/test/'),backup:null,blocked:false});
 assert.equal(summary.targets[0].status,'published');assert.equal(summary.targets[1].status,'review');assert.equal(summary.targets[1].format,'story');assert.equal(summary.publicationComplete,false);
 assert.notEqual(summary.targets[0].stages.P7.evidence[0].evidence_id,summary.targets[1].stages.P7.evidence[0].evidence_id);
});
test('text-only P14 требует покрытия точного job/inputHash и manifest, а не пустого списка медиа',()=>{
 const now=Date.now(),textJob={id:'text-job',materialId:'case',revision:2,manifestRevision:3,inputHash:'a'.repeat(64),input:{files:[]},targets:[]};
 const backup={independentRussianCopyVerified:true,restoreVerified:true,artifact_ref:'isolated-audit',checked_at:new Date(now).toISOString(),expires_at:new Date(now+3600000).toISOString(),coveredSha256:[]};
 const check=b=>intakeQueueSummary(textJob,{backup:b,now}).stages.P14.result;
 assert.notEqual(check(backup),'passed');
 const coverage={jobId:textJob.id,materialId:'case',revision:2,manifestRevision:3,inputHash:textJob.inputHash};
 assert.equal(check({...backup,coveredJobs:[coverage]}),'passed');assert.notEqual(check({...backup,coveredJobs:[{...coverage,inputHash:'b'.repeat(64)}]}),'passed');
});
test('P14 медиа требует state/job и все исходники, публикационные версии и обложки',()=>{
 const now=Date.now(),sha=['a','b','c'].map(x=>x.repeat(64)),j={id:'job',materialId:'case',revision:1,manifestRevision:1,inputHash:'d'.repeat(64),input:{files:[{sha256:sha[0]}]},result:{variants:[{mediaIds:['video'],entry:{media:[{coverMediaId:'cover'}]}}]},targets:[]};
 const coverage={jobId:j.id,materialId:j.materialId,revision:1,manifestRevision:1,inputHash:j.inputHash},backup={independentRussianCopyVerified:true,restoreVerified:true,artifact_ref:'isolated-audit',checked_at:new Date(now).toISOString(),expires_at:new Date(now+10000).toISOString(),coveredSha256:sha};
 const check=(b,mediaRows=()=>[{mediaId:'video',sha256:sha[1]},{mediaId:'cover',sha256:sha[2]}])=>intakeQueueSummary(j,{backup:b,now,mediaRows}).stages.P14.result;
 assert.notEqual(check(backup),'passed');assert.equal(check({...backup,coveredJobs:[coverage]}),'passed');assert.notEqual(check({...backup,coveredJobs:[coverage],coveredSha256:sha.slice(0,2)}),'passed');assert.notEqual(check({...backup,coveredJobs:[coverage]},()=>[{mediaId:'video',sha256:sha[1]}]),'passed');
});
test('scoped VK rework не теряет текущий TG старой ревизии и не закрывает комплект',()=>{
 const initial={...job,id:'old',revision:1,status:'completed',targets:[{channel:'telegram',format:'post'},{channel:'vk',format:'post'}],queueResults:{'telegram:post':{id:'tg',contentHash:'h1'},'vk:post':{id:'oldvk',contentHash:'old'}}};
 const revised={...job,id:'new',revision:2,status:'queued',artifactsVerified:false,targets:[{channel:'vk',format:'post'}],queueResults:{}};
 const state={materials:{case:{id:'case',revision:2,targets:initial.targets,targetJobs:{'telegram:post':'old','vk:post':'new'},mode:'submitted',card:{}}},jobs:{old:initial,new:revised}};
 const data={tg:entry('tg','h1','approved'),vk:entry('vk','h2','published','https://vk.com/wall-1_2')},app={store:{read:()=>structuredClone(state),tx:fn=>fn(state)}};
 const sync=()=>syncIntakeQueue(app,{getEntry:id=>data[id],backup:null,blocked:false});sync();
 assert.equal(state.materials.case.queueSummary.targets.length,2);assert.equal(state.materials.case.workflowClosed,false);
 Object.assign(revised,{status:'completed',artifactsVerified:true,queueResults:{'vk:post':{id:'vk',contentHash:'h2'}}});sync();
 assert.equal(state.materials.case.queueSummary.outcome,'partial');assert.equal(state.materials.case.workflowClosed,false);
 data.tg.status='published';data.tg.result.link='https://t.me/test/1';sync();assert.equal(state.materials.case.queueSummary.publicationComplete,true);assert.equal(state.materials.case.workflowClosed,true);
});
