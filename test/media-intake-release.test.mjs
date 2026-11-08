import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'intake-release-'));process.env.DATA_DIR=dir;process.env.ZAVOD_ENV_FILE=path.join(dir,'absent.env');delete process.env.QUEUE_API_BASE;
process.env.TG_BOT_TOKEN='test-token';process.env.TG_GROUP_ID='-1001';process.env.TG_CHANNEL='@test';process.env.APPROVER_IDS='42';
globalThis.fetch=async()=>new Response(JSON.stringify({ok:true,result:{message_id:1}}));
const store=await import('../src/queue/store.mjs'),{runOnce}=await import('../src/queue/runner.mjs'),{_setAdapter}=await import('../src/channels/index.mjs'),runtime=await import('../src/bot/media-intake-runtime.mjs'),{config}=await import('../src/lib/config.mjs');config().release.mode='commissioning';
const now=Date.parse('2030-06-04T09:00:00Z');
async function approved(id,revision=1){const name=`mi-${id}-${revision}`,raw={channel:'telegram',kind:'post',name,material:'intake:'+id,text:'Образец покрытия показан на фото.',media:[],facts:[],date:'2030-06-04',time:'12:00'};
 const e=(await store.put(raw)).entry;await store.transition(e.id,'review');await store.transition(e.id,'approved',{approval:{at:new Date(now).toISOString()}});return{entry:store.get(e.id),raw};}
test('late manifest и отмена задания удерживают старое согласие без внешнего вызова',async()=>{
 let calls=0;_setAdapter('telegram',{publish:async()=>{calls++;return{ok:true,id:'test',link:'https://t.me/test/1'};}});
 for(const [id,revision,mode]of [['a'.repeat(16),2,'submitted'],['b'.repeat(16),1,'cancelled']]){
  const {entry}=await approved(id);runtime.instance().store.tx(s=>{s.materials[id]={id,revision,mode,card:{},files:[]};});
  const result=await runOnce({now});assert.ok(result.waiting.includes(entry.name));assert.equal(store.get(entry.id).status,'approved');
 }assert.equal(calls,0);
});
test('изменение задания во время подготовки транспорта проверяется перед publish',async()=>{
 const id='c'.repeat(16),{entry,raw}=await approved(id);let calls=0;
 runtime.instance().store.tx(s=>{s.materials[id]={id,revision:1,mode:'submitted',card:{},files:[]};s.jobs.race={id:'race',materialId:id,revision:1,status:'completed',artifactsVerified:true,input:{timing:{mode:'after_approval'},facts:[]},targets:[{channel:'telegram',format:'album'}],result:{variants:[{channel:'telegram',format:'album',text:raw.text,mediaIds:[],entry:raw}]}};});
 _setAdapter('telegram',{publish:async()=>{calls++;return{ok:true,id:'test',link:'https://t.me/test/2'};}});
 const result=await runOnce({now,resolveMedia:async e=>{runtime.instance().store.tx(s=>{s.materials[id].revision=2;});return e;}});
 assert.equal(calls,0);assert.ok(result.waiting.includes(entry.name));
});
