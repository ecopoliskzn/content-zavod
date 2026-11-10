import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'manual-delivery-'));process.env.DATA_DIR=dir;process.env.ZAVOD_ENV_FILE=path.join(dir,'absent.env');delete process.env.TG_BOT_TOKEN;delete process.env.TG_RELAY_URL;delete process.env.TG_GROUP_ID;
const {sendReply,sendPackage}=await import('../src/channels/manual.mjs');
const base={id:'a'.repeat(16),channel:'threads',kind:'reply',contentHash:'b'.repeat(16),text:'Синтетический ответ.',link:'https://www.threads.net/@company/post/test',date:'2030-01-01',time:'12:00'};
for(const [name,send]of [['reply',sendReply],['package',sendPackage]]){
 test(`${name}: отказ текста не становится handed, повтор без второго заголовка`,async()=>{
  let result={},calls=0;const deliver=async()=>++calls===2?{ok:false,kind:'refused',status:400}:{ok:true,kind:'ok',messageId:calls};
  const options={steps:['Разместить согласованное.'],deliver,onState:async patch=>{result={...result,...patch};}};
  const first=await send({...base,result},options);assert.equal(first.ok,false);assert.equal(first.retry,true);assert.equal(result.packageMessageId,1);
  const second=await send({...base,result},options);assert.equal(second.ok,true);assert.equal(second.manual,true);assert.equal(calls,3);
  await send({...base,result},options);assert.equal(calls,3);
 });
 test(`${name}: неизвестный ACK тела и legacy header не повторяются вслепую`,async()=>{
  let result={},calls=0;const options={steps:[],deliver:async()=>++calls===1?{ok:true,messageId:1}:{ok:false,kind:'network'},onState:async patch=>{result={...result,...patch};}};
  assert.equal((await send({...base,result},options)).ok,false);const next=await send({...base,result},options);assert.equal(next.ok,false);assert.equal(next.retry,false);assert.equal(calls,2);
  assert.equal((await send({...base,result:{packageMessageId:777}},options)).ok,false);assert.equal(calls,2);
 });
}
test('многочастный текст продолжает недоставленный кусок и не переиспользует чужое содержание',async()=>{
 let result={},calls=0;const entry={...base,text:'x'.repeat(8000)},options={steps:[],deliver:async()=>++calls===3?{ok:false,kind:'refused'}:{ok:true,messageId:calls},onState:async patch=>{result={...result,...patch};}};
 assert.equal((await sendPackage({...entry,result},options)).ok,false);assert.deepEqual(result.manualDelivery.body.ids,[2]);
 assert.equal((await sendPackage({...entry,result},options)).ok,true);assert.deepEqual(result.manualDelivery.body.ids,[2,4,5]);assert.equal(calls,5);
 assert.equal((await sendPackage({...entry,text:'Изменённый текст.',result},options)).ok,false);assert.equal(calls,5);
});
