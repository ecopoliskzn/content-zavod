import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
process.env.DATA_DIR=mkdtempSync(path.join(tmpdir(),'ig-form-'));process.env.ZAVOD_ENV_FILE=path.join(process.env.DATA_DIR,'absent.env');process.env.IG_TOKEN='synthetic';process.env.IG_RELAY_URL='https://relay.invalid';process.env.IG_RELAY_SECRET='synthetic';
const {ig}=await import('../src/lib/ig.mjs');
test('параметры контейнера/выпуска идут формой, а сообщения сохраняют JSON',async()=>{
 const old=globalThis.fetch,requests=[];globalThis.fetch=async(url,init)=>{requests.push({url:String(url),init});return Response.json({id:'synthetic'});};
 try{
  await ig('own/media',{method:'POST',body:{image_url:'https://example.org/frame.jpg?a=1&b=2',is_carousel_item:true,caption:'Подпись\nвторая строка'}});
  await ig('own/media_publish',{method:'POST',body:{creation_id:'container'}});
  for(const r of requests)assert.equal(r.init.headers['content-type'],'application/x-www-form-urlencoded');
  const body=new URLSearchParams(requests[0].init.body);assert.equal(body.get('image_url'),'https://example.org/frame.jpg?a=1&b=2');assert.equal(body.get('is_carousel_item'),'true');assert.equal(body.get('caption'),'Подпись\nвторая строка');
  await ig('own/messages',{method:'POST',body:{recipient:{id:'synthetic'},message:{text:'synthetic'}}});assert.equal(requests[2].init.headers['content-type'],'application/json');
 }finally{globalThis.fetch=old;}
});
