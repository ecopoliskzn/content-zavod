// Сквозной CLI-прогон: настоящий HTTP/CLI/диск, вымышленные материалы и очередь.
// Никаких Telegram/площадок, ключей аккаунтов или личной переписки в тесте нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
const dir=mkdtempSync(path.join(tmpdir(),'intake-cli-flow-'));
process.env.DATA_DIR=dir;process.env.ZAVOD_ENV_FILE=path.join(dir,'absent.env');
const {createIntake}=await import('../src/bot/media-intake.mjs');
const lib=await import('../src/media/library.mjs');
const {verifyIntakeResult,deliverIntakeResults}=await import('../src/bot/media-intake-delivery.mjs');
const {normalize,contentHash}=await import('../src/queue/format.mjs');

test('CLI claim → question → ответ → context → facts → result → review с числом и источником',async t=>{
 const file=path.join(dir,'sample.png');writeFileSync(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfWQAAAAASUVORK5CYII=','base64'));
 const targets=[{channel:'telegram',account_ref:'synthetic-tg',format:'album',delivery_mode:'auto',readiness:'passed',verified_at:'2026-11-07T00:00:00Z'},{channel:'vk',account_ref:'synthetic-vk',format:'photopost',delivery_mode:'auto',readiness:'passed',verified_at:'2026-11-07T00:00:00Z'}];
 const app=createIntake({dir:path.join(dir,'state'),config:{enabled:true,groupId:'-100123',topicId:9,authors:['11'],coordinators:[],coordinatorMode:'operator-admin',approvers:['33'],handoffMode:'B',policyVersion:'pilot-1',quietMs:0,targets,limits:{maxFiles:10,maxBytes:20_000_000,maxPending:10,maxText:4000,maxJobInput:20000,maxJobOutput:10000,maxCalls:4}},
  telegram:async()=>({ok:true,messageId:501}),verifyResult:verifyIntakeResult,importFile:async a=>({...await lib.importMedia(file,{material:a.material,source:a.source,variant:a.variant}),verified:true,readable:true})});
 let seq=1;
 await app.handleUpdate({update_id:seq,message:{message_id:seq,from:{id:11},chat:{id:-100123},message_thread_id:9,caption:'Длина образца 40 мм. Показать общий вид.',photo:[{file_id:'synthetic',file_unique_id:'unique',file_size:readFileSync(file).length}]}});
 const id=app.list()[0].id;
 const click=async action=>app.handleUpdate({update_id:++seq,callback_query:{id:'c'+seq,from:{id:11},data:`mi:${id}:${app.show(id).revision}:${action}`,message:{message_id:501,chat:{id:-100123},message_thread_id:9}}});
 await click('rights');await click('prepare');const job=app.jobs()[0];assert.equal(job.input.facts.length,0);
 const queue=new Map(),executeQueue=async(cmd,args)=>{if(cmd==='add'){const e=normalize(args.entries);queue.set(e.id,{...e,status:'draft',contentHash:contentHash(e)});}else if(cmd==='submit'){const e=queue.get(args.ref);e.status='review';e.approval={card:{messageId:700},cardHash:e.contentHash,preview:{complete:true}};}return{code:0};};
 const server=createServer(async(req,res)=>{try{
  assert.equal(req.headers.authorization,'Bearer synthetic-only');const chunks=[];for await(const chunk of req)chunks.push(chunk);const {cmd,args}=JSON.parse(Buffer.concat(chunks));let data;
  if(cmd==='intake-jobs')data=app.jobs().map(({id,materialId,revision,inputHash,status,recipient,protocolVersion,manifestRevision})=>({id,materialId,revision,inputHash,status,recipient,protocolVersion,manifestRevision}));
  else if(cmd==='intake-claim'){assert.ok(args.expected);data=app.claim(args.id,args.owner,args.requestId,args.expected);}
  else if(cmd==='intake-question')data=app.question(args.id,args.owner,args.token,args.question);
  else if(cmd==='intake-context')data=app.context(args.id,args.owner,args.token);
  else if(cmd==='intake-facts')data=app.facts(args.id,args.revision,args.jobId,args.owner,args.token,args.facts);
  else if(cmd==='intake-result'){data=app.result(args.id,args.owner,args.token,args.result);if(data.ok)await deliverIntakeResults(app,{getEntry:id=>queue.get(id),executeQueue});}
  else throw Error('unexpected command');
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({code:data.ok===false?1:0,lines:[],data}));
 }catch{res.writeHead(500);res.end('{}');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const cli=fileURLToPath(new URL('../src/bot/media-intake-cli.mjs',import.meta.url));
 const run=args=>new Promise((resolve,reject)=>execFile(process.execPath,[cli,...args],{env:{...process.env,QUEUE_API_BASE:`http://127.0.0.1:${server.address().port}`,ADMIN_API_TOKEN:'synthetic-only'},timeout:30000},(error,stdout)=>error?reject(error):resolve(stdout)));
 await run(['claim','--id='+job.id,'--owner=S1']);const claim=path.join(dir,'intake-editor',job.id+'.json');assert.equal(JSON.parse(readFileSync(claim)).job.id,job.id);
 const question=path.join(dir,'question.json');writeFileSync(question,JSON.stringify({text:'Уточните документ с измерением',allowOmit:true}));await run(['question','--claim='+claim,'--file='+question]);
 await app.handleUpdate({update_id:++seq,message:{message_id:seq,from:{id:11},chat:{id:-100123},message_thread_id:9,text:'Документ клиента: акт измерения образца, 07.11.2026.',reply_to_message:{message_id:501}}});
 await run(['context','--claim='+claim]);let receipt=JSON.parse(readFileSync(claim));const current=app.context(job.id,'S1',receipt.token);assert.equal(current.questions[0].status,'answered');assert.equal(current.revision,job.revision);
 const factsFile=path.join(dir,'facts.json');writeFileSync(factsFile,JSON.stringify({sources:[{id:'measure',kind:'client-document',locator:'документ клиента: синтетический акт измерения, 07.11.2026',text:'Длина образца 40 мм.'}],facts:[{sourceId:'measure',claim:'Длина образца 40 мм.',confirmed:true}],resolutions:[{questionId:current.questions[0].id,type:'source',sourceId:'measure',claims:['Длина образца 40 мм.']}]}));
 await run(['facts','--claim='+claim,'--file='+factsFile]);receipt=JSON.parse(readFileSync(claim));assert.equal(receipt.job.inputHash,app.jobs()[0].inputHash);assert.notEqual(receipt.job.inputHash,job.inputHash);
 const publication=await lib.importMedia(file,{material:'intake:'+id,source:'synthetic derivative',role:'publication',parent:receipt.job.input.files[0].mediaId,variant:'post'}),text='Образец длиной 40 мм показан общим планом. Рассмотрите его поверхность.';
 const output=path.join(dir,'result.json');writeFileSync(output,JSON.stringify({inputHash:receipt.job.inputHash,editorialReview:{result:'passed',policyVersion:'pilot-1'},variants:targets.map(target=>({channel:target.channel,format:target.format,text,mediaIds:[publication.mediaId],entry:{channel:target.channel,kind:'post',name:`mi-${id}-${job.revision}`,material:'intake:'+id,text,media:[{type:'image',mediaId:publication.mediaId}],facts:receipt.job.input.facts}}))}));
 await run(['result','--claim='+claim,'--result='+output]);assert.equal(queue.size,2);assert.ok([...queue.values()].every(e=>e.status==='review'));assert.equal(app.jobs()[0].status,'completed');
});
