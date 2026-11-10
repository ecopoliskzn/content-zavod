import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'comments-flow-'));process.env.DATA_DIR=dir;process.env.ZAVOD_ENV_FILE=path.join(dir,'absent.env');
const {collect,all,readScheduledThreads}=await import('../src/comments/collect.mjs'),{flushCommentNotifications}=await import('../src/comments/notifications.mjs'),{readJson}=await import('../src/lib/files.mjs');
test('collect без send сохраняет находку; следующий fresh=0 всё равно доставляет сводку',async()=>{
 const row={id:'threads:flow',platform:'threads',at:'2026-11-10T06:00:00Z',text:'Синтетический вопрос.',link:'https://www.threads.net/@x/post/1'};
 const sourceReaders={threads:async()=>({items:[row],coverage:{complete:true,posts:1}})},clock=()=>Date.parse('2026-11-10T07:00:00Z');
 assert.equal((await collect({sourceReaders,clock})).fresh.length,1);assert.equal((await collect({sourceReaders,clock})).fresh.length,0);
 let deliveries=0;const out=await flushCommentNotifications(all(),{file:path.join(dir,'flow-notifications.json'),deliver:async()=>{deliveries++;return{kind:'ok',messageId:91};},only:['threads']});assert.equal(out.sent,1);assert.equal(deliveries,1);
});
test('ошибка/пустые цели не записываются как успешный Threads-проход; повтор ограничен',async()=>{
 const now=Date.parse('2026-11-10T08:00:00Z');let calls=0;
 await readScheduledThreads({now,read:async()=>{calls++;return{error:'empty inventory',coverage:{complete:false,posts:0}};}});
 const state=readJson(path.join(dir,'comments-state.json'));assert.equal(state.threadsAt,undefined);assert.ok(state.threadsAttemptAt);
 assert.ok((await readScheduledThreads({now:now+1000,read:async()=>{calls++;return{};}})).skipped);assert.equal(calls,1);
});
