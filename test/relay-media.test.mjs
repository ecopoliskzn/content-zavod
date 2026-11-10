import test from 'node:test';
import assert from 'node:assert/strict';
import {handle} from '../ops/relay/relay.mjs';

const path='/media/'+ 'a'.repeat(64)+'.jpg';
test('релей передаёт только публичный JPEG по точному хешу без сохранения и секретов',async()=>{
  const calls=[];
  const res=await handle(new Request('https://relay.example'+path,{headers:{cookie:'private','x-ig-token':'secret'}}),{ORIGIN_URL:'https://origin.example'},async(url,init)=>{
    calls.push({url,init});return new Response(new Uint8Array([255,216,255,1]),{headers:{'content-type':'image/jpeg','content-length':'4','set-cookie':'private'}});
  });
  assert.equal(res.status,200);assert.equal(calls.length,1);assert.equal(calls[0].url,'https://origin.example'+path);
  assert.equal(calls[0].init.redirect,'manual');assert.equal(calls[0].init.headers.cookie,undefined);assert.equal(calls[0].init.headers['x-ig-token'],undefined);
  assert.equal(res.headers.get('content-type'),'image/jpeg');assert.equal(res.headers.get('set-cookie'),null);assert.equal(res.headers.get('cache-control'),'no-store');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()),new Uint8Array([255,216,255,1]));
});
test('релей закрывает произвольные пути, query, POST и неподходящий origin-ответ',async()=>{
  let calls=0;const fetcher=async()=>{calls++;return new Response('html',{headers:{'content-type':'text/html'}});};
  for(const [p,method]of [[path+'?x=1','GET'],['/media/private.jpg','GET'],['/media/'+ 'a'.repeat(64)+'.png','GET'],[path,'POST']]){
    assert.equal((await handle(new Request('https://relay.example'+p,{method}),{ORIGIN_URL:'https://origin.example'},fetcher)).status,404);
  }
  assert.equal(calls,0);
  assert.equal((await handle(new Request('https://relay.example'+path),{ORIGIN_URL:'https://origin.example'},fetcher)).status,502);
});
test('согласованный MP4 идёт потоком с проверенным Range только от фиксированного origin',async()=>{
 const p='/media/approved/'+'a'.repeat(16)+'/'+'b'.repeat(16)+'/med_'+'c'.repeat(32)+'.mp4';
 const res=await handle(new Request('https://relay.example'+p,{headers:{range:'bytes=1-3',cookie:'private'}}),{ORIGIN_URL:'https://origin.example'},async(url,init)=>{assert.equal(url,'https://origin.example'+p);assert.equal(init.headers.range,'bytes=1-3');assert.equal(init.headers.cookie,undefined);return new Response(new Uint8Array([1,2,3]),{status:206,headers:{'content-type':'video/mp4','content-length':'3','content-range':'bytes 1-3/10'}});});
 assert.equal(res.status,206);assert.equal(res.headers.get('content-range'),'bytes 1-3/10');assert.equal(res.headers.get('cache-control'),'no-store');
 const denied=await handle(new Request('https://relay.example'+p),{ORIGIN_URL:'https://origin.example'},async()=>new Response(null,{status:404}));assert.equal(denied.status,404);
});
