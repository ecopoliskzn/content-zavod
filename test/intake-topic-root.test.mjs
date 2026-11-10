import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
const root=mkdtempSync(path.join(tmpdir(),'intake-topic-root-'));process.env.DATA_DIR=root;process.env.ZAVOD_ENV_FILE=path.join(root,'absent.env');
const {createIntake}=await import('../src/bot/media-intake.mjs');
const config={enabled:true,groupId:'-100123',topicId:309,authors:['11'],coordinators:[],approvers:['22'],quietMs:0,handoffMode:'B',policyVersion:'fixture',targets:[{channel:'telegram',format:'text',account_ref:'own',readiness:'passed',delivery_mode:'auto'}],limits:{maxFiles:10,maxBytes:1000,maxPending:20,maxText:4000}};
const message=(id,reply=309)=>({update_id:id,message:{message_id:id,chat:{id:-100123},message_thread_id:309,from:{id:11},text:'Синтетическое описание материала',reply_to_message:{message_id:reply}}});
function fixture(){let cards=0;const app=createIntake({dir:mkdtempSync(path.join(root,'case-')),config,telegram:async()=>({ok:true,messageId:1000+(++cards)}),importFile:async()=>({verified:true,readable:true,mediaId:'med_'+'a'.repeat(32),sha256:'b'.repeat(64),bytes:10,mime:'image/jpeg'})});return{app,cards:()=>cards};}
test('обычное сообщение и фото с Telegram reply на корень темы создают материалы; неизвестный настоящий reply не теряется в новый материал',async()=>{
 const {app,cards}=fixture();await app.handleUpdate(message(400));assert.equal(app.list().length,1);assert.equal(cards(),1);
 const photo=message(401);delete photo.message.text;photo.message.photo=[{file_id:'synthetic',file_unique_id:'unique',file_size:10}];await app.handleUpdate(photo);assert.equal(app.list().length,2);assert.equal(app.list().filter(r=>r.files===1).length,1);
 await app.handleUpdate(message(402,999));assert.equal(app.list().length,2);assert.equal(app.jobs().length,0);
});
test('восстановление касается только старых ignored root-событий; повтор не создаёт дубль и не присваивает согласие',async()=>{
 const {app}=fixture();app.store.tx(s=>{for(const [id,reply,author]of [[400,309,'11'],[401,999,'11'],[402,309,'99']])s.events['up:'+id]={kind:'message',status:'ignored',updateId:id,messageId:id,author,reply,text:'Синтетическое описание',source:{messageId:id,caption:'Синтетическое описание'},at:new Date().toISOString()};});
 assert.equal(app.recoverTopicRootEvents().recovered,1);await app.flush();assert.equal(app.list().length,1);assert.equal(app.jobs().length,0);assert.equal(app.show(app.list()[0].id).rights.status,'needs_clarification');assert.equal(app.recoverTopicRootEvents().recovered,0);
});
