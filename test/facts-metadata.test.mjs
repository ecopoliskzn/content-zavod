import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
process.env.DATA_DIR=mkdtempSync(path.join(tmpdir(),'facts-metadata-'));process.env.ZAVOD_ENV_FILE=path.join(process.env.DATA_DIR,'absent.env');
const store=await import('../src/queue/store.mjs');
test('новые источники facts сохраняются при прежнем тексте и прежних хешах',async()=>{
 const raw={channel:'vk',kind:'post',name:'same-text-new-facts',material:'case:synthetic',date:'2030-06-01',time:'12:00',text:'Гарантия на объекте составляет 5 лет.',facts:[]};
 const before=(await store.put(raw)).entry;const facts=[{claim:'5 лет',source:'Письменное подтверждение компании, 06.11.2026'}];
 const r=await store.put({...raw,facts});assert.equal(r.result,'обновлена');assert.deepEqual(store.get(before.id).facts,facts);assert.equal(r.entry.contentHash,before.contentHash);assert.equal(r.entry.hash,before.hash);
 assert.equal((await store.put({...raw,facts})).result,'без изменений');
});
