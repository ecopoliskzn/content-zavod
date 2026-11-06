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
  assert.equal(calls[0].init.redirect,'error');assert.equal(calls[0].init.headers.cookie,undefined);assert.equal(calls[0].init.headers['x-ig-token'],undefined);
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
