import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
process.env.DATA_DIR=mkdtempSync(path.join(tmpdir(),'approval-video-'));process.env.ZAVOD_ENV_FILE=path.join(process.env.DATA_DIR,'absent.env');process.env.TG_BOT_TOKEN='synthetic';process.env.TG_GROUP_ID='-1001';process.env.TG_TOPIC_APPROVAL='70';delete process.env.TG_RELAY_URL;
const {previewVideo}=await import('../src/bot/approval-video.mjs');
const entry={material:'case:synthetic',contentHash:'same',media:[{type:'video',url:'https://example.org/video.mp4'}]};
test('нативное видео отправляется только в рабочую тему, повтор использует подтверждённый ID',async()=>{
 const calls=[];globalThis.fetch=async(url,init)=>{
  if(String(url).startsWith('https://example.org'))return new Response('synthetic-video');
  calls.push({method:String(url).split('/').pop(),body:init.body});return Response.json({ok:true,result:{message_id:100,chat:{id:-1001},video:{file_id:'synthetic'}}});
 };
 const states=[],p=await previewVideo(entry,null,async s=>states.push(s));
 assert.equal(calls.length,1);assert.equal(calls[0].method,'sendVideo');assert.equal(calls[0].body.get('message_thread_id'),'70');
 assert.deepEqual(p.messageIds,['100']);assert.equal(p.complete,true);assert.equal(states[0].sending,true);
 assert.deepEqual(await previewVideo(entry,p,async()=>{}),p);assert.equal(calls.length,1);
});
test('неподтверждённое видео не получает complete и не повторяется слепо',async()=>{
 let sends=0,pending;
 globalThis.fetch=async(url)=>{if(String(url).startsWith('https://example.org'))return new Response('video');sends++;return Response.json({ok:true,result:{message_id:101,chat:{id:-999},video:{}}});};
 await assert.rejects(()=>previewVideo(entry,null,async s=>{pending=s;}),/не подтвердил/);
 assert.equal(pending.sending,true);await assert.rejects(()=>previewVideo(entry,pending,async()=>{}));assert.equal(sends,1);
});
test('безопасность: исходник чужого материала не выдаётся, неоднозначный previous не повторяется',async()=>{
 globalThis.fetch=async()=>{throw Error('unexpected network');};
 await assert.rejects(()=>previewVideo({...entry,media:[{type:'video',mediaId:'unknown'}]},null,async()=>{}),/нет публикационной версии/);
 await assert.rejects(()=>previewVideo(entry,{sending:true},async()=>{}),/неоднозначна/);
});
