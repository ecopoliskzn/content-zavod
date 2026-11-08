import test from 'node:test';import assert from 'node:assert/strict';import {intakeQueueSummary} from '../src/bot/media-intake-sync.mjs';
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
