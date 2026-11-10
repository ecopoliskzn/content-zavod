// Изолированная транспортная проба на синтетическом задании, без клиента/Telegram/публикаций.
// Тот же core claim/context/question обслуживается только на loopback с отдельным секретом.
// Production queue, конфигурация, роли, материалы темы309 и карточка312 не затрагиваются.
import {createServer} from 'node:http';import {randomBytes} from 'node:crypto';import {fileURLToPath} from 'node:url';import path from 'node:path';import {existsSync,readFileSync,mkdirSync} from 'node:fs';
const role=process.argv.includes('--probe-role=S2')?'S2':'S1';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),folder=path.join(root,'data',role==='S2'?'intake-dispatch-probe-s2':'intake-dispatch-probe');
process.env.ZAVOD_ENV_FILE=path.join(folder,'absent.env');process.env.DATA_DIR=path.join(folder,'consumer-data');
const read=(file,fallback)=>existsSync(file)?JSON.parse(readFileSync(file,'utf8')):fallback;
export async function serveProbe(){
 const {createIntake}=await import('../src/bot/media-intake.mjs'),{durableJson}=await import('./intake-dispatch-host.mjs');
 mkdirSync(folder,{recursive:true,mode:0o700});const apiToken=randomBytes(32).toString('hex'),entries={};
 const config={enabled:true,groupId:'-100123',topicId:9,authors:['11'],coordinators:['22'],approvers:['33'],handoffMode:'A',policyVersion:'transport-probe-only',quietMs:0,targets:[{channel:'telegram',account_ref:'synthetic',format:'text',delivery_mode:'auto',readiness:'passed',verified_at:new Date().toISOString()}],limits:{maxFiles:10,maxBytes:100000,maxPending:20,maxText:4000,maxJobInput:24000,maxJobOutput:24000,maxCalls:4}};
 if(role==='S2')config.targets=[{...config.targets[0],channel:'youtube',format:'video'}];
 const app=createIntake({dir:path.join(folder,'server-state'),config,telegram:async()=>({ok:true,messageId:777}),verifyResult:()=>true,getQueueEntry:id=>entries[id],importFile:async()=>({mediaId:'med_'+'e'.repeat(32),sha256:'f'.repeat(64),bytes:1,mime:'video/mp4',verified:true,readable:true})});
 if(!app.jobs().length){const common={message_id:1,chat:{id:-100123},message_thread_id:9,from:{id:11}};await app.handleUpdate({update_id:1,message:role==='S2'?{...common,caption:'Техническая проверка маршрута S2. Синтетические метаданные, самого ролика нет.',video:{file_id:'synthetic',file_unique_id:'synthetic-video',file_size:1}}:{...common,text:'Техническая проверка передачи задания. Не материал клиента.'}});const m=app.list()[0];app.edit(m.id,m.revision,'11',{rights:true});app.prepare(m.id,app.show(m.id).revision,'11');}
 const server=createServer(async(req,res)=>{
  const reply=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
  if(req.method!=='POST'||req.url!=='/admin/queue'||req.headers.authorization!=='Bearer '+apiToken){reply(403,{code:1});return;}
  let body='';for await(const chunk of req){body+=chunk;if(body.length>65536){reply(413,{code:1});return;}}
  try{const {cmd,args:a={}}=JSON.parse(body);let data;
   if(cmd==='intake-jobs')data=app.jobs().map(j=>({id:j.id,materialId:j.materialId,revision:j.revision,inputHash:j.inputHash,status:j.status,current:j.targets.length>0&&j.targets.every(t=>app.isCurrentTarget(j.id,`${t.channel}:${t.format}`)),recipient:j.recipient,protocolVersion:j.protocolVersion,manifestRevision:j.manifestRevision,claimFencingVersion:1,acceptedClaimsComplete:j.acceptedClaimsComplete===true,acceptedClaims:j.acceptedClaims||[],continuation:app.continuations().find(e=>e.jobId===j.id)||null}));
   else if(cmd==='intake-claim')data=app.claim(a.id,a.owner,a.requestId,a.expected);
   else if(cmd==='intake-context')data=app.context(a.id,a.owner,a.token);
   else if(cmd==='intake-question')data=app.question(a.id,a.owner,a.token,a.question);
   else if(cmd==='intake-probe-answer'){await app.flush();await app.handleUpdate({update_id:2,message:{message_id:2,chat:{id:-100123},message_thread_id:9,from:{id:11},reply_to_message:{message_id:777},text:'Синтетический ответ для проверки продолжения.'}});data={ok:true};}
   else if(cmd==='intake-probe-rework'){
    const j=app.jobs().find(j=>j.status==='claimed');if(!j)throw Error();
    const variant={channel:'telegram',format:'text',text:'Синтетический предыдущий текст.',mediaIds:[],entry:{text:'Синтетический предыдущий текст.',facts:[]}};
    const result=app.result(j.id,j.claim.owner,j.claim.token,{inputHash:j.inputHash,variants:[variant],editorialReview:{result:'passed',policyVersion:'transport-probe-only'}});if(!result.ok)throw Error();
    entries['synthetic-entry']={id:'synthetic-entry',channel:'telegram',material:'intake:'+j.materialId,contentHash:'synthetic-hash',status:'rework',note:'Техническая дельта: сократить синтетический текст.'};app.store.tx(s=>{s.jobs[j.id].queueResults={'telegram:text':{id:'synthetic-entry',contentHash:'synthetic-hash'}};});data=app.queueFeedback(j.id,'telegram:text');
   }else{reply(403,{code:1});return;}
   reply(200,{code:data?.ok===false?1:0,data});
  }catch{reply(400,{code:1});}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 durableJson(path.join(folder,'private-config.json'),{api:'http://127.0.0.1:'+server.address().port,token:apiToken});
 console.log(JSON.stringify({status:'ISOLATED_PROBE_READY',port:server.address().port,jobCount:app.jobs().length,productionEffects:false}));
}
async function client(action,args){
 const {durableJson,dispatchEnvelope,intakeHostCycle}=await import('./intake-dispatch-host.mjs'),{reconcileIntakeDispatch}=await import('./intake-dispatch.mjs');
 const privateConfig=read(path.join(folder,'private-config.json'),null);if(!privateConfig)throw Error();
 process.env.ZAVOD_ENV_FILE=path.join(folder,'absent.env');process.env.DATA_DIR=path.join(folder,'consumer-data');process.env.QUEUE_API_BASE=privateConfig.api;process.env.ADMIN_API_TOKEN=privateConfig.token;
 const call=async(cmd,args={})=>{const r=await fetch(privateConfig.api+'/admin/queue',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+privateConfig.token},body:JSON.stringify({cmd,args})});const data=await r.json();if(data.code!==0)throw Error();return data.data;};
 const dispatchFolder=path.join(folder,'consumer-data','intake-dispatch');
 if(action==='plan'){const jobs=await call('intake-jobs'),file=path.join(dispatchFolder,'outbox.json'),previous=read(file,{}),state=reconcileIntakeDispatch(previous,jobs);durableJson(file,state);for(const item of Object.values(state))if(item.status==='planned'){const envelope=path.join(dispatchFolder,'envelopes',item.dispatchId+'.json');durableJson(envelope,dispatchEnvelope(item));console.log(JSON.stringify({envelope,kind:item.kind||'initial',dispatchId:item.dispatchId,requestId:item.requestId,jobId:item.jobId}));}return;}
 if(action==='send'){const codex=path.join(process.env.LOCALAPPDATA,'OpenAI','Codex','bin','a159911ff70742e9','codex.exe');console.log(JSON.stringify(await intakeHostCycle({folder:dispatchFolder,metadata:()=>call('intake-jobs'),sendEnabled:true,codex,review:false,technicalProbe:true})));return;}
 if(action==='status'){const jobs=await call('intake-jobs');console.log(JSON.stringify({jobs,productionEffects:false}));return;}
 if(action==='answer'||action==='rework'){await call('intake-probe-'+action);console.log(JSON.stringify({ok:true,productionEffects:false}));return;}
 const cli=await import('../src/bot/media-intake-cli.mjs');await cli.main([action,...args]);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const [action,...args]=process.argv.slice(2);(action==='serve'?serveProbe():client(action,args)).catch(()=>{console.error('Изолированная транспортная проба не завершена; production не затрагивается.');process.exitCode=2;});}
