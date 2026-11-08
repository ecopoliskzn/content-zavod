import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'intake-scope-'));process.env.DATA_DIR=dir;process.env.ZAVOD_ENV_FILE=path.join(dir,'absent.env');
const {createIntake}=await import('../src/bot/media-intake.mjs'),legal=await import('../src/leads/legal.mjs');
test('служебный приём не включает заявки: только заданные группа, тема и автор',()=>{
 legal._setLegalReady(false);const app=createIntake({dir,config:{enabled:true,groupId:'-1001',topicId:9,authors:['11'],coordinators:[],coordinatorMode:'operator-admin',approvers:['33'],limits:{maxPending:20,maxText:4000}}});
 const message={message_id:1,chat:{id:-1001,type:'supergroup'},message_thread_id:9,from:{id:11},photo:[{file_id:'file',file_unique_id:'unique',file_size:12}]};
 for(const patch of [{chat:{id:11,type:'private'}},{chat:{id:-1002,type:'supergroup'}},{message_thread_id:10},{from:{id:99}}])assert.equal(app.ingest({update_id:1,message:{...message,...patch}}).accepted,false);
 assert.equal(Object.keys(app.store.read().events).length,0);assert.equal(legal.legalReady(),false);assert.equal(app.ingest({update_id:2,message}).accepted,true);assert.equal(Object.keys(app.store.read().events).length,1);assert.equal(legal.legalReady(),false);
});
