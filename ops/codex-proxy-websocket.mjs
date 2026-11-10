// app-server proxy передаёт сырые байты control socket, а не JSONL.
// Node WebSocket выполняет Upgrade/framing; одноразовый loopback bridge только
// переносит байты в собственный child. Никаких RPC/инициализации/чтения auth здесь нет.
import net from 'node:net';import {spawn} from 'node:child_process';import {randomBytes} from 'node:crypto';

const error=code=>Object.assign(new Error(code),{code});
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
export function openCodexProxyWebSocket(executable,{spawnChild=spawn,timeoutMs=30000,handshakeTimeoutMs=Math.min(timeoutMs,5000),maxMessageBytes=262144,maxBytes=2097152,maxBufferedBytes=262144,signal}={}){
 if(typeof executable!=='string'||!executable||!integer(timeoutMs,1,60000)||!integer(handshakeTimeoutMs,1,timeoutMs)||![maxMessageBytes,maxBytes,maxBufferedBytes].every(v=>integer(v,1,16777216)))return Promise.reject(error('PROXY_OPTIONS'));
 return new Promise((resolve,reject)=>{
  const listeners=new Set(),sockets=new Set(),path='/'+randomBytes(24).toString('hex');let ws,child,owned,ending=false,opened=false,childExited=false,wireBytes=0,applicationBytes=0;
  let closeResolve;const closed=new Promise(r=>{closeResolve=r;});let lifetime,handshake;
  const server=net.createServer(socket=>{
   sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{if(socket===owned)void finish('stream_error');});
   socket.setTimeout(handshakeTimeoutMs,()=>socket.destroy());
   if(owned||ending){socket.destroy();return;}
   let header=Buffer.alloc(0);const preface=bytes=>{
    header=Buffer.concat([header,bytes]);const end=header.indexOf('\r\n\r\n');
    if(header.length>8192){socket.destroy();return;}if(end<0)return;
    // Непредсказуемый путь известен только созданному ниже WebSocket. Чужие
    // loopback-соединения не получают доступа к child и не занимают его слот.
    const first=header.indexOf('\r\n');if(header.subarray(0,first).toString()!==`GET ${path} HTTP/1.1`){socket.destroy();return;}
    owned=socket;socket.setTimeout(0);socket.removeListener('data',preface);server.close();for(const other of sockets)if(other!==socket)other.destroy();
    try{child=spawnChild(executable,['app-server','proxy'],{stdio:['pipe','pipe','ignore'],windowsHide:true,shell:false});}catch{void finish('spawn');return;}
    child.on('error',()=>void finish('spawn'));child.once('close',()=>{childExited=true;if(!ending)void finish('child_closed');});
    if(!child.stdin||!child.stdout){void finish('spawn');return;}
    const count=bytes=>{wireBytes+=bytes.length;if(wireBytes>maxBytes)void finish('byte_limit');};
    child.stdin.on('error',()=>void finish('stream_error'));child.stdout.on('error',()=>void finish('stream_error'));
    child.stdout.on('data',count);socket.on('data',count);socket.once('end',()=>{if(!ending)void finish('socket_closed');});
    child.stdout.pipe(socket);socket.pipe(child.stdin);
    const initial=Buffer.concat([Buffer.from('GET / HTTP/1.1'),header.subarray(first)]);count(initial);if(!ending)child.stdin.write(initial);header=Buffer.alloc(0);
   };socket.on('data',preface);
  });
  server.maxConnections=2;
  async function finish(reason){
   if(ending)return closed;ending=true;clearTimeout(lifetime);clearTimeout(handshake);signal?.removeEventListener('abort',aborted);
   try{if(ws&&ws.readyState<2)ws.close();}catch{}
   for(const socket of sockets)socket.destroy();
   const serverClosed=new Promise(r=>{server.close(()=>r());});
   if(child){child.stdin?.destroy();child.stdout?.destroy();if(!childExited){try{child.kill();}catch{}}}
   // Реальный child завершается событием close. При зависшем teardown остаётся
   // жёсткий предел и SIGKILL; неполная очистка явно видна вызывающему коду.
   if(child&&!childExited)await new Promise(r=>{const timer=setTimeout(r,100);const done=()=>{clearTimeout(timer);r();};child.once('close',done);});
   if(child&&!childExited){try{child.kill('SIGKILL');}catch{}await new Promise(r=>{const timer=setTimeout(r,100);child.once('close',()=>{clearTimeout(timer);r();});});}
   await serverClosed;listeners.clear();const result={reason,cleanupComplete:!child||childExited};closeResolve(result);
   if(!opened)reject(error('PROXY_'+reason.toUpperCase()));return result;
  }
  const aborted=()=>void finish('aborted');signal?.addEventListener('abort',aborted,{once:true});
  server.on('error',()=>void finish('bridge'));server.on('listening',()=>{
   if(ending){server.close();return;}
   try{ws=new WebSocket(`ws://127.0.0.1:${server.address().port}${path}`);}catch{void finish('websocket');return;}
   ws.addEventListener('error',()=>void finish('websocket'));
   ws.addEventListener('close',()=>{if(!ending)void finish('socket_closed');});
   ws.addEventListener('message',event=>{
    if(ending)return;if(typeof event.data!=='string'){void finish('invalid_message');return;}
    if(Buffer.byteLength(event.data)>maxMessageBytes){void finish('message_limit');return;}
    let message;try{message=JSON.parse(event.data);if(!message||typeof message!=='object'||Array.isArray(message))throw Error();}catch{void finish('invalid_message');return;}
    for(const listener of listeners){try{listener(message);}catch{void finish('listener_error');break;}}
   });
   ws.addEventListener('open',()=>{
    if(ending)return;opened=true;clearTimeout(handshake);
    resolve({closed,close:()=>finish('closed'),onMessage(listener){if(typeof listener!=='function')throw error('PROXY_LISTENER');if(ending)throw error('PROXY_CLOSED');listeners.add(listener);return()=>listeners.delete(listener);},send(message){
     if(ending||ws.readyState!==WebSocket.OPEN)throw error('PROXY_CLOSED');let serialized;try{if(!message||typeof message!=='object'||Array.isArray(message))throw Error();serialized=JSON.stringify(message);}catch{throw error('PROXY_INVALID_MESSAGE');}
     const size=Buffer.byteLength(serialized);if(size>maxMessageBytes||applicationBytes+size>maxBytes||ws.bufferedAmount+size>maxBufferedBytes)throw error('PROXY_SEND_LIMIT');applicationBytes+=size;ws.send(serialized);
    }});
   });
  });
  lifetime=setTimeout(()=>void finish('timeout'),timeoutMs);handshake=setTimeout(()=>void finish('handshake_timeout'),handshakeTimeoutMs);
  if(signal?.aborted){void finish('aborted');return;}server.listen(0,'127.0.0.1');
 });
}
