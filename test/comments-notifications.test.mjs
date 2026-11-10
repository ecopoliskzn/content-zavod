import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
import {flushCommentNotifications} from '../src/comments/notifications.mjs';
const rows=[{id:'threads:1',platform:'threads',status:'new',text:'Синтетический вопрос.',link:'https://www.threads.net/@x/post/r',foundAt:'2026-11-10T06:00:00Z'}];
test('уже сохранённый комментарий доставляется без fresh; известный отказ повторяется, успех не дублируется',async()=>{
 const file=path.join(mkdtempSync(path.join(tmpdir(),'comment-outbox-')),'outbox.json');let calls=0;
 const deliver=async()=>++calls===1?{kind:'refused',status:429}:{kind:'ok',messageId:55};
 assert.equal((await flushCommentNotifications(rows,{file,deliver})).sent,0);assert.equal((await flushCommentNotifications(rows,{file,deliver})).sent,1);assert.equal((await flushCommentNotifications(rows,{file,deliver})).sent,0);assert.equal(calls,2);
});
test('неизвестный ACK и аварийное sending не повторяются вслепую; skipped не уведомляется заново',async()=>{
 const file=path.join(mkdtempSync(path.join(tmpdir(),'comment-unknown-')),'outbox.json');let calls=0;const deliver=async()=>{calls++;return{kind:'network'};};
 assert.equal((await flushCommentNotifications(rows,{file,deliver})).unknown,1);await flushCommentNotifications(rows,{file,deliver});assert.equal(calls,1);
 const empty=await flushCommentNotifications([{...rows[0],status:'skipped'}],{file:path.join(path.dirname(file),'skipped.json'),deliver});assert.equal(empty.sent,0);assert.equal(calls,1);
});
