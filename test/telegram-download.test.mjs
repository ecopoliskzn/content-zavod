import test from 'node:test';
import assert from 'node:assert/strict';
import {handle} from '../ops/relay/relay.mjs';
const config={TG_RELAY_SECRET:'relay-test',TG_BOT_TOKEN:'token-test'};
const request=(body={file_id:'AgAC_test'},secret='relay-test')=>new Request('https://relay.example/download/getFile',{method:'POST',headers:{'x-relay-secret':secret,'content-type':'application/json'},body:JSON.stringify(body)});
const metadata=(file_path='photos/file_1.jpg',file_size=4)=>new Response(JSON.stringify({ok:true,result:{file_path,file_size}}));
test('скачивание требует секрет и file_id, произвольный URL не принимается',async()=>{
 let calls=0;const fetcher=async()=>{calls++;throw Error('not expected');};
 assert.equal((await handle(request({},'wrong'),config,fetcher)).status,401);
 for(const body of [{},{file_id:'https://evil.example/file'},{file_id:'ok',url:'https://evil.example'}])assert.equal((await handle(request(body),config,fetcher)).status,400);
 assert.equal(calls,0);
});
test('релей скачивает только с Telegram, без redirect, cookie и раскрытия токена',async()=>{
 const calls=[];const r=await handle(request(),config,async(url,init)=>{calls.push({url,init});return calls.length===1?metadata():new Response(new Uint8Array([255,216,255,0]),{headers:{'set-cookie':'secret'}});});
 assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('content-length'),'4');assert.equal(r.headers.get('set-cookie'),null);
 assert.equal(calls[0].url,'https://api.telegram.org/bottoken-test/getFile');assert.equal(calls[1].url,'https://api.telegram.org/file/bottoken-test/photos/file_1.jpg');
 for(const call of calls){assert.equal(call.init.redirect,'manual');assert.equal(call.init.headers?.cookie,undefined);}
 assert.deepEqual(new Uint8Array(await r.arrayBuffer()),new Uint8Array([255,216,255,0]));
});
test('поддельный путь, слишком большой файл и сетевой отказ дают безопасный отказ',async()=>{
 for(const [file,size] of [['../token.jpg',4],['https://evil.example/x.jpg',4],['photos/a.jpg',21*1024*1024],['photos/a.jpg',0]]){
  let calls=0;const r=await handle(request(),config,async()=>{calls++;return metadata(file,size);});assert.equal(r.status,502);assert.equal(calls,1);
 }
 const r=await handle(request(),config,async()=>{throw Error('https://api.telegram.org/bottoken-test');});assert.equal(r.status,502);assert.ok(!(await r.text()).includes('token-test'));
});
test('обрыв и превышение заявленного размера разрывают поток',async()=>{
 for(const bytes of [new Uint8Array(3),new Uint8Array(5)]){
  let calls=0;const r=await handle(request(),config,async()=>++calls===1?metadata():new Response(bytes));assert.equal(r.status,200);await assert.rejects(()=>r.arrayBuffer());
 }
});
test('Workers не поддерживает redirect:error; ручной режим отклоняет любой редирект',async()=>{
 let calls=0;const workerFetch=async(url,init)=>{if(init.redirect==='error')throw new TypeError('unsupported redirect mode');calls++;return calls===1?metadata():new Response(new Uint8Array(4));};
 assert.equal((await handle(request(),config,workerFetch)).status,200);
 for(const redirectAt of [1,2]){let count=0;const r=await handle(request(),config,async(url,init)=>{assert.equal(init.redirect,'manual');count++;return count===redirectAt?new Response(null,{status:302,headers:{location:'https://evil.example'}}):metadata();});assert.equal(r.status,502);assert.equal(count,redirectAt);}
});
