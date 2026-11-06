import test from 'node:test';
import assert from 'node:assert/strict';
import {detectChanges,acknowledgeBatch,remarkFingerprint} from '../ops/review-watch.mjs';

const id='fda3e7578d62a698',other='f07defb6acd90d31';
const entry=(over={})=>({id,name:'hibiny-1-ecm-7925',channel:'youtube',status:'review',contentHash:'h1',...over});
test('пустая очередь и уже обработанная правка не будят редактора',()=>{
 const note='Заменить заголовок';const state={statuses:{[id]:'rework'},handledRemarkFingerprints:[remarkFingerprint(id,note)]};
 assert.equal(detectChanges([{id,note}], [entry({status:'rework'})],state).events.length,0);
 assert.equal(detectChanges([], [entry()],{statuses:{[id]:'review'}}).events.length,0);
});
test('новое замечание передаётся без авторов и лишних полей, чужая запись исключена',()=>{
 const note='Убрать последний абзац';const result=detectChanges([{id,note,by:'PRIVATE AUTHOR',preview:'PRIVATE PREVIEW'},{id:'outside',note:'PRIVATE OTHER'}],[entry({status:'rework'})],{statuses:{[id]:'review'}});
 assert.equal(result.events.length,1);assert.equal(result.events[0].type,'remark');assert.equal(result.events[0].note,note);
 const text=JSON.stringify(result);assert.equal(text.includes('PRIVATE'),false);
 assert.equal(detectChanges([{id,note}],[entry({status:'review'})],{}).events.length,0);
});
test('новое одобрение и результат выпуска будят основную сессию, старый отказ молчит',()=>{
 assert.equal(detectChanges([],[entry({status:'approved',approval:{at:'2026-11-06T10:00:00Z',by:'PRIVATE'}})],{statuses:{[id]:'review'}}).events[0].type,'status');
 assert.equal(detectChanges([],[entry({status:'published',result:{id:'own',link:'https://youtu.be/own'}})],{statuses:{[id]:'approved'}}).events[0].status,'published');
 assert.equal(detectChanges([],[entry({status:'failed'})],{statuses:{[id]:'failed'}}).events.length,0);
});
test('подтверждение доставки не равно обработке, повторный пакет не отправляется',()=>{
 const result=detectChanges([{id,note:'Новая правка'}],[entry({status:'rework'})],{statuses:{[id]:'review'}});
 const state={pending:{id:'a'.repeat(64),events:result.events,observed:result.observed,attempted:true},dispatched:[]};
 assert.throws(()=>acknowledgeBatch(state,'b'.repeat(64)));
 const ack=acknowledgeBatch(state,'a'.repeat(64));assert.equal(ack.pending,null);assert.equal(ack.handledRemarkFingerprints,undefined);
 assert.equal(detectChanges([{id,note:'Новая правка'}],[entry({status:'rework'})],ack).events.length,0);
 assert.equal(detectChanges([{id,note:'Другая правка'}],[entry({status:'rework'})],ack).events.length,1);
});
test('разные записи и новые одобрения одной записи имеют разные отпечатки',()=>{
 assert.notEqual(remarkFingerprint(id,'x'),remarkFingerprint(other,'x'));
 const one=detectChanges([],[entry({status:'approved',approval:{at:'one'}})],{statuses:{[id]:'review'}});
 const two=detectChanges([],[entry({status:'approved',approval:{at:'two'}})],{statuses:{[id]:'review'}});
 assert.notEqual(one.events[0].key,two.events[0].key);
});
test('пакет статуса не сохраняет cookie, ключи запроса и вложенные объекты ответа',()=>{
 const result=detectChanges([],[entry({status:'published',approval:{by:'PRIVATE AUTHOR'},result:{id:'own',link:'https://user:PRIVATE_PASSWORD@www.instagram.com/reel/own/?access_token=PRIVATE_TOKEN#PRIVATE_FRAGMENT',raw:{cookie:'PRIVATE_COOKIE'}}})],{statuses:{[id]:'approved'}});
 assert.equal(JSON.stringify(result).includes('PRIVATE'),false);assert.equal(result.events[0].result.link,'https://www.instagram.com/reel/own/');
});
