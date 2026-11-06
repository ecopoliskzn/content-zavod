import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
process.env.DATA_DIR=mkdtempSync(path.join(tmpdir(),'ig-images-'));process.env.ZAVOD_ENV_FILE=path.join(process.env.DATA_DIR,'absent.env');process.env.IG_USER_ID='own';process.env.IG_TOKEN='synthetic';delete process.env.IG_RELAY_URL;
const {publish}=await import('../src/channels/instagram.mjs');
test('PNG в карусели отклоняется до первого контейнера с понятным отказом',async()=>{
 const old=globalThis.fetch;let api=0;globalThis.fetch=async url=>{if(String(url).startsWith('https://example.org'))return new Response(new Uint8Array([137,80,78,71]),{headers:{'content-type':'image/png'}});api++;return Response.json({error:{message:'Only photo or video can be accepted as media type.',code:9004}});};
 try{const r=await publish({kind:'carousel',media:[{type:'image',url:'https://example.org/a.png'}]},{sleep:async()=>{}});assert.equal(r.ok,false);assert.match(r.error,/JPEG/);assert.equal(api,0);}finally{globalThis.fetch=old;}
});
test('JPEG проверяется по байтам, порядок и подпись передаются без изменений',async()=>{
 const old=globalThis.fetch,bodies=[];let n=0;globalThis.fetch=async(url,opts)=>{if(String(url).startsWith('https://example.org'))return new Response(new Uint8Array([255,216,255,224]),{headers:{'content-type':'image/jpeg','content-length':'4'}});if(opts?.body)bodies.push(Object.fromEntries(new URLSearchParams(opts.body)));return Response.json(String(url).includes('?fields=')?{status_code:'FINISHED'}:{id:String(++n),permalink:'https://www.instagram.com/p/synthetic'});};
 try{const media=[{type:'image',url:'https://example.org/4.jpg'},{type:'image',url:'https://example.org/3.jpg'}];const r=await publish({kind:'carousel',text:'caption unchanged',media},{sleep:async()=>{}});assert.equal(r.ok,true);assert.deepEqual(bodies.filter(x=>x.image_url).map(x=>x.image_url),media.map(x=>x.url));assert.equal(bodies.find(x=>x.media_type==='CAROUSEL').caption,'caption unchanged');}finally{globalThis.fetch=old;}
});
test('ложный MIME JPEG с байтами PNG не создаёт контейнер',async()=>{
 const old=globalThis.fetch;let api=0;globalThis.fetch=async url=>{if(String(url).startsWith('https://example.org'))return new Response(new Uint8Array([137,80,78,71]),{headers:{'content-type':'image/jpeg'}});api++;return Response.json({id:'unexpected'});};
 try{const r=await publish({kind:'carousel',media:[{type:'image',url:'https://example.org/fake.jpg'}]},{sleep:async()=>{}});assert.equal(r.ok,false);assert.equal(api,0);}finally{globalThis.fetch=old;}
});
