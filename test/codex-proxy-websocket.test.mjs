// Изолированный RFC6455 peer: настоящий Node WebSocket клиента, синтетический child.
import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {Writable,PassThrough} from 'node:stream';import {createHash} from 'node:crypto';import net from 'node:net';
import {openCodexProxyWebSocket} from '../ops/codex-proxy-websocket.mjs';
const frame=(value,opcode=1,fin=true)=>{const body=Buffer.from(value),head=body.length<126?Buffer.from([(fin?128:0)|opcode,body.length]):Buffer.from([(fin?128:0)|opcode,126,body.length>>8,body.length&255]);return Buffer.concat([head,body]);};
function peer(mode='rpc'){
 const state={spawned:0,killed:0,messages:[],masked:true,port:null,header:null};let child;
 const spawnChild=(executable,args,options)=>{
  state.spawned++;assert.equal(executable,'synthetic-codex');assert.deepEqual(args,['app-server','proxy']);assert.equal(options.windowsHide,true);assert.equal(options.shell,false);
  child=new EventEmitter();child.stdout=new PassThrough();let buffer=Buffer.alloc(0),upgraded=false;
  child.stdin=new Writable({write(chunk,encoding,done){buffer=Buffer.concat([buffer,chunk]);
   if(!upgraded){const end=buffer.indexOf('\r\n\r\n');if(end<0){done();return;}state.header=buffer.subarray(0,end).toString();buffer=buffer.subarray(end+4);state.port=Number(/Host: 127\.0\.0\.1:(\d+)/i.exec(state.header)?.[1]);assert.match(state.header,/^GET \/ HTTP\/1\.1/);assert.match(state.header,/Upgrade: websocket/i);assert.match(state.header,/Connection: upgrade/i);
    if(mode==='hang'){done();return;}if(mode==='exit'){queueMicrotask(()=>child.emit('close',1));done();return;}
    const key=/Sec-WebSocket-Key: (.+)/i.exec(state.header)?.[1].trim(),accept=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    child.stdout.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+(mode==='bad-upgrade'?'invalid':accept)+'\r\n\r\n');upgraded=true;
   }
   while(buffer.length>=2){const opcode=buffer[0]&15,masked=Boolean(buffer[1]&128);state.masked&&=masked;let size=buffer[1]&127,offset=2;if(size===126){if(buffer.length<4)break;size=buffer.readUInt16BE(2);offset=4;}if(size===127)throw Error('unexpected fixture frame size');if(buffer.length<offset+(masked?4:0)+size)break;const mask=buffer.subarray(offset,offset+4);if(masked)offset+=4;const body=Buffer.from(buffer.subarray(offset,offset+size));if(masked)for(let i=0;i<body.length;i++)body[i]^=mask[i%4];buffer=buffer.subarray(offset+size);
    if(opcode!==1)continue;const message=JSON.parse(body);state.messages.push(message);
    if(mode==='malformed')child.stdout.write(frame('{broken'));
    else if(mode==='oversize')child.stdout.write(frame('x'.repeat(2048)));
    else if(mode==='binary')child.stdout.write(frame('binary',2));
    else{const json=JSON.stringify({id:message.id,result:{echo:message.params}}),cut=7;child.stdout.write(frame(json.slice(0,cut),1,false));child.stdout.write(frame(json.slice(cut),0,true));}
   }done();}});
  child.kill=signal=>{state.killed++;if(mode==='unkillable'||mode==='stubborn'&&signal!=='SIGKILL')return false;queueMicrotask(()=>child.emit('close',0));return true;};return child;
 };return{state,spawnChild,get child(){return child;}};
}
async function noListener(port){if(!port)return;await new Promise((resolve,reject)=>{const socket=net.connect({host:'127.0.0.1',port});socket.once('error',()=>resolve());socket.once('connect',()=>{socket.destroy();reject(Error('bridge left listening'));});});}
test('стандартный Upgrade, masked JSON-RPC, fragmented response и идемпотентная очистка',async()=>{
 const p=peer(),connection=await openCodexProxyWebSocket('synthetic-codex',{spawnChild:p.spawnChild,timeoutMs:2000});
 const received=new Promise(resolve=>connection.onMessage(resolve));connection.send({id:1,method:'initialize',params:{test:'синтетика'}});assert.deepEqual(await received,{id:1,result:{echo:{test:'синтетика'}}});assert.equal(p.state.masked,true);assert.equal(p.state.messages.length,1);await noListener(p.state.port);
 await connection.close();await connection.close();assert.equal(p.state.killed,1);assert.equal(p.child.stdin.destroyed,true);assert.equal(p.child.stdout.destroyed,true);assert.equal((await connection.closed).reason,'closed');assert.throws(()=>connection.send({id:2}),/closed/i);
});
test('handshake timeout/invalid Upgrade/child exit освобождают child и listener',async()=>{
 for(const mode of ['hang','bad-upgrade','exit']){const p=peer(mode);await assert.rejects(openCodexProxyWebSocket('synthetic-codex',{spawnChild:p.spawnChild,timeoutMs:500,handshakeTimeoutMs:120}),error=>/^PROXY_/.test(error.code));assert.ok(p.state.killed<=1);assert.equal(p.child.stdin.destroyed,true);assert.equal(p.child.stdout.destroyed,true);await noListener(p.state.port);}
});
test('ошибка spawn и сбой потока не оставляют зависшее соединение',async()=>{
 await assert.rejects(openCodexProxyWebSocket('synthetic-codex',{spawnChild:()=>{throw Error('private detail');},timeoutMs:300}),error=>error.code==='PROXY_SPAWN'&&!error.message.includes('private'));
 const p=peer(),c=await openCodexProxyWebSocket('synthetic-codex',{spawnChild:p.spawnChild,timeoutMs:1000});p.child.stdin.emit('error',Error('private stream detail'));assert.equal((await c.closed).reason,'stream_error');assert.equal(p.state.killed,1);
});
test('повреждённый JSON, binary и слишком большой ответ закрывают транспорт',async()=>{
 for(const mode of ['malformed','oversize','binary']){const p=peer(mode),c=await openCodexProxyWebSocket('synthetic-codex',{spawnChild:p.spawnChild,timeoutMs:1500,maxMessageBytes:512});c.send({id:1,method:'initialize'});assert.equal((await c.closed).reason,mode==='oversize'?'message_limit':'invalid_message');assert.equal(p.state.killed,1);}
});
test('lifetime и исходящий лимит ограничены, listeners можно снять',async()=>{
 const p=peer(),c=await openCodexProxyWebSocket('synthetic-codex',{spawnChild:p.spawnChild,timeoutMs:250,maxMessageBytes:128});let called=false;const off=c.onMessage(()=>{called=true;});off();assert.throws(()=>c.send({text:'x'.repeat(300)}),/limit/i);assert.equal((await c.closed).reason,'timeout');assert.equal(called,false);assert.equal(p.state.killed,1);
});
test('общий wire limit, AbortSignal и ошибка обработчика также очищают соединение',async()=>{
 const p=peer('oversize'),c=await openCodexProxyWebSocket('synthetic-codex',{spawnChild:p.spawnChild,timeoutMs:1000,maxBytes:1000,maxMessageBytes:4000});c.send({id:1});assert.equal((await c.closed).reason,'byte_limit');assert.equal(p.state.killed,1);
 const abort=new AbortController();abort.abort();const never=peer();await assert.rejects(openCodexProxyWebSocket('synthetic-codex',{spawnChild:never.spawnChild,signal:abort.signal}),e=>e.code==='PROXY_ABORTED');assert.equal(never.state.spawned,0);
 const activeAbort=new AbortController(),a=peer(),ac=await openCodexProxyWebSocket('synthetic-codex',{spawnChild:a.spawnChild,signal:activeAbort.signal});activeAbort.abort();assert.equal((await ac.closed).reason,'aborted');assert.equal(a.state.killed,1);
 const b=peer(),bc=await openCodexProxyWebSocket('synthetic-codex',{spawnChild:b.spawnChild});bc.onMessage(()=>{throw Error('private handler error');});bc.send({id:2});assert.equal((await bc.closed).reason,'listener_error');assert.equal(b.state.killed,1);
});
test('зависший child получает SIGKILL, невозможность подтвердить exit видна как отказ очистки',async()=>{
 const p=peer('stubborn'),c=await openCodexProxyWebSocket('synthetic-codex',{spawnChild:p.spawnChild});assert.equal((await c.close()).cleanupComplete,true);assert.equal(p.state.killed,2);
 const failed=peer('unkillable'),fc=await openCodexProxyWebSocket('synthetic-codex',{spawnChild:failed.spawnChild});assert.equal((await fc.close()).cleanupComplete,false);assert.equal(failed.state.killed,2);assert.equal(failed.child.stdin.destroyed,true);await noListener(failed.state.port);
});
