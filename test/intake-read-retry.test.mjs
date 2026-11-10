import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {tmpdir} from 'node:os';
process.env.ZAVOD_ENV_FILE=path.join(tmpdir(),'absent-read-retry.env');process.env.QUEUE_API_BASE='https://fixture.invalid';process.env.ADMIN_API_TOKEN='synthetic-only';const {intakeJobMetadata}=await import('../src/bot/media-intake-cli.mjs');
test('один сетевой сбой чтения статуса повторяется ограниченно, без изменения задания',async()=>{
 const original=globalThis.fetch;let count=0;globalThis.fetch=async(url,options)=>{count++;assert.equal(JSON.parse(options.body).cmd,'intake-jobs');if(count===1)throw Error('simulated network');return new Response(JSON.stringify({code:0,data:[]}));};
 try{assert.deepEqual(await intakeJobMetadata(),[]);assert.equal(count,2);}finally{globalThis.fetch=original;}
});
