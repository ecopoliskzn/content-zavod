import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'intake-http-'));process.env.DATA_DIR=dir;process.env.ZAVOD_ENV_FILE=path.join(dir,'absent.env');process.env.TG_WEBHOOK_SECRET='test-hook';process.env.ADMIN_API_TOKEN='test-admin';
const {createHandler}=await import('../src/server.mjs');
async function run(intake,fn,deliver=async()=>{}){const server=createServer(createHandler({intake,deliver}));await new Promise(r=>server.listen(0,'127.0.0.1',r));try{return await fn('http://127.0.0.1:'+server.address().port);}finally{await new Promise(r=>server.close(r));}}
const post=(url,secret='test-hook')=>fetch(url+'/tg/update',{method:'POST',headers:{'x-telegram-bot-api-secret-token':secret},body:JSON.stringify({update_id:123})});
test('durable отказ даёт 503 до ACK, без фоновой обработки',async()=>{
 let flush=0;await run({ingest:()=>{throw Error('disk');},flush:async()=>{flush++;}},async url=>assert.equal((await post(url)).status,503));assert.equal(flush,0);
});
test('после durable приёма ACK не ждёт скачивания; неверный секрет inbox не вызывает',async()=>{
 const calls=[];let finish;const pending=new Promise(r=>finish=r);
 await run({ingest:()=>{calls.push('persisted');return{accepted:true};},flush:async()=>{calls.push('flush');await pending;}},async url=>{
  assert.equal((await post(url,'wrong')).status,401);assert.equal(calls.length,0);assert.equal((await post(url)).status,200);assert.deepEqual(calls,['persisted','flush']);finish();
 });
});
test('intake-admin защищён ключом; успешный result передаётся штатному мосту',async()=>{
 let admin=0,delivered=0;await run({admin:async()=>{admin++;return{code:0};}},async url=>{
  const request=secret=>fetch(url+'/admin/queue',{method:'POST',headers:{authorization:'Bearer '+secret},body:JSON.stringify({cmd:'intake-result',args:{}})});
  assert.equal((await request('wrong')).status,401);assert.equal(admin,0);assert.equal((await request('test-admin')).status,200);assert.equal(admin,1);assert.equal(delivered,1);
 },async()=>{delivered++;});
});
