import test from 'node:test';import assert from 'node:assert/strict';
import {codexThreadControl} from '../ops/codex-dispatch-control.mjs';
const threadId='01a1439c-0fdc-79d2-bce1-3968327bb807';
function transport({changed=false,refused=false}={}){let listener,close;const calls=[];return{calls,open:async()=>({closed:new Promise(r=>{close=r;}),onMessage:fn=>{listener=fn;return()=>{};},close:async()=>{close({reason:'closed',cleanupComplete:true});return{cleanupComplete:true};},send:message=>{calls.push(message);if(message.id)queueMicrotask(()=>listener({id:message.id,...(refused&&message.id===2?{error:{code:-1}}:{result:message.id===1?{}:{thread:{id:threadId,status:{type:message.id===3?'idle':'notLoaded'},model:changed&&message.id===3?'different':'saved-model',reasoningEffort:'high'},model:'saved-model',reasoningEffort:'high'}})}));}})};}
test('read/resume существующего UUID не передаёт prompt/model/config и не меняет модель',async()=>{
 const t=transport(),r=await codexThreadControl('fake',threadId,{resume:true,open:t.open});assert.equal(r.ok,true);assert.equal(r.resumed,true);assert.equal(r.modelPreserved,true);assert.equal(r.generationRequested,false);
 assert.deepEqual(t.calls.map(x=>x.method),['initialize','initialized','thread/read','thread/resume']);
 assert.deepEqual(t.calls.at(-1).params,{threadId,excludeTurns:true});assert.deepEqual(t.calls[2].params,{threadId,includeTurns:false});
});
test('read не возобновляет, отказ и смена модели не считаются успешными',async()=>{
 let t=transport();assert.equal((await codexThreadControl('fake',threadId,{open:t.open})).status,'notLoaded');assert.equal(t.calls.length,3);
 t=transport({refused:true});assert.equal((await codexThreadControl('fake',threadId,{resume:true,open:t.open})).ok,false);assert.equal(t.calls.length,3);
 t=transport({changed:true});assert.equal((await codexThreadControl('fake',threadId,{resume:true,open:t.open})).ok,false);
 await assert.rejects(()=>codexThreadControl('fake','foreign',{open:t.open}),/unsupported/);
});
