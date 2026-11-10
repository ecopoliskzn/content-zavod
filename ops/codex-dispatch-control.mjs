// Штатный control socket упакованного Codex CLI. Не создаёт чаты/turn/prompt,
// не читает auth/историю и не переопределяет модель: только metadata и resume UUID.
import {fileURLToPath} from 'node:url';import path from 'node:path';
import {openCodexProxyWebSocket} from './codex-proxy-websocket.mjs';
const allowed=new Set(['01a13496-1b98-7ca0-9fc7-a9c2f5584e25','01a1349f-f8f1-7b30-8189-a9d4882c4be7','01a1439c-0fdc-79d2-bce1-3968327bb807']);
export async function codexThreadControl(codex,threadId,{resume=false,open=openCodexProxyWebSocket}={}){
 if(!allowed.has(threadId))throw Error('unsupported editor thread');
 let connection,stage='connect',nextId=0;const pending=new Map();
 try{
  connection=await open(codex);
  connection.onMessage(message=>{const p=pending.get(message.id);if(!p)return;pending.delete(message.id);if(message.error){const e=Error('RPC_REFUSED');e.rpcCode=Number.isSafeInteger(message.error.code)?message.error.code:null;const text=String(message.error.message||'').toLowerCase();e.reason=['already has an active writer','already initialized','already loaded','already running','already exists','already subscribed','not found','model','permission','config','unsupported','experimental','auth','rollout','already'].find(s=>text.includes(s))||'refused';p.reject(e);}else p.resolve(message.result);});
  connection.closed.then(()=>{for(const p of pending.values())p.reject(Error('CONTROL_CLOSED'));pending.clear();});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});try{connection.send({id,method,params});}catch(e){pending.delete(id);reject(e);}});
  stage='initialize';await rpc('initialize',{clientInfo:{name:'ecopolis_event_dispatcher',version:'1.0'}});connection.send({method:'initialized',params:{}});
  stage='thread_read';const before=(await rpc('thread/read',{threadId,includeTurns:false}))?.thread;
  if(before?.id!==threadId)throw Error('THREAD_ID_MISMATCH');
  const result={ok:true,threadId,model:before.model??null,reasoningEffort:before.reasoningEffort??null,status:before.status?.type,generationRequested:false};
  if(resume){
   if(typeof before.model!=='string'||!before.model)throw Error('SAVED_MODEL_UNAVAILABLE');
   // Без model/config: сервер использует сохранённые настройки именно этого чата.
   stage='thread_resume';const resumed=await rpc('thread/resume',{threadId,excludeTurns:true}),after=resumed?.thread;
   if(after?.id!==threadId)throw Error('THREAD_ID_MISMATCH');
   const model=after.model??resumed.model??null,effort=after.reasoningEffort??resumed.reasoningEffort??null;
   const modelPreserved=before.model!==null&&before.model!==undefined&&model===before.model&&effort===(before.reasoningEffort??null);
   Object.assign(result,{ok:modelPreserved,resumed:true,modelPreserved,model,reasoningEffort:effort,status:after.status?.type});
  }
  return result;
 }catch(e){return{ok:false,stage,...(e.rpcCode!==undefined?{rpcCode:e.rpcCode,reason:e.reason}:{}),generationRequested:false};}
 finally{if(connection){try{const cleanup=await connection.close();if(cleanup?.cleanupComplete!==true)return{ok:false,stage:'cleanup',generationRequested:false};}catch{return{ok:false,stage:'cleanup',generationRequested:false};}}}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const executable=path.resolve('node_modules/intake-codex-runtime/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
 codexThreadControl(executable,process.argv[2],{resume:process.argv.includes('--resume')}).then(value=>{console.log(JSON.stringify(value));if(!value.ok)process.exitCode=2;}).catch(()=>{process.exitCode=2;});
}
