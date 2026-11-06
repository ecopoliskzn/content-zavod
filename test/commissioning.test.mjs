// Проверки режима сдачи: редакционная сетка не задерживает выпуск,
// согласие, рубильники и подтверждение площадки остаются обязательными.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
process.env.DATA_DIR=mkdtempSync(path.join(tmpdir(),'commissioning-'));
process.env.ZAVOD_ENV_FILE=path.join(process.env.DATA_DIR,'absent.env');
delete process.env.QUEUE_API_BASE;
const {config,channelNames,channel}=await import('../src/lib/config.mjs');
const {slotFor}=await import('../src/queue/slots.mjs');
const {effectiveDue}=await import('../src/queue/timing.mjs');
const store=await import('../src/queue/store.mjs');
const {runOnce}=await import('../src/queue/runner.mjs');
const {_setAdapter}=await import('../src/channels/index.mjs');
const {wantedPublishAt,KEEP}=await import('../src/video/schedule.mjs');
const {setStop,clearStop}=await import('../src/queue/switch.mjs');
const now=Date.parse('2030-03-12T23:30:00+03:00');
config().release.mode='commissioning';

test('все восемь площадок: немедленно после согласия, даже ночью и при редакционном потолке',()=>{
 for(const name of channelNames()){
  const entry={id:'current',name:'current',channel:name,kind:'post',date:'2030-03-13',time:'18:30'};
  const busy=Array.from({length:30},(_,i)=>({...entry,id:'busy-'+i,status:'approved',date:'2030-03-12',time:'23:30'}));
  assert.deepEqual(slotFor(entry,busy,channel(name),now),{date:'2030-03-12',time:'23:30'},name);
  assert.equal(effectiveDue(entry,now),now,name);
 }
});

test('явное завтра и период сохраняются, технический повтор не наследует старую сетку',()=>{
 const e={channel:'instagram',date:'2030-03-13',time:'18:30',status:'failed'};
 assert.equal(slotFor(e,[],channel('instagram'),now).date,'2030-03-12');
 const timing={mode:'at',date:'2030-03-13',time:'15:00'};
 assert.deepEqual(slotFor({...e,timing},[],channel('instagram'),now),{date:timing.date,time:timing.time});
 assert.ok(effectiveDue({...e,timing},now)>now);
 assert.equal(slotFor({...e,timing:{mode:'period',from:'2030-03-13T10:00',to:'2030-03-13T11:00'}},[],channel('instagram'),now).time,'10:00');
});

test('YouTube не получает просроченный или автоматический будущий publishAt; до Одобрить закрыт',()=>{
 const e={channel:'youtube',status:'approved',contentHash:'same',date:'2030-03-13',time:'15:00',extra:{youtubeId:'synthetic',youtubeHash:'same'}};
 assert.equal(wantedPublishAt(e,{now}),KEEP);
 assert.equal(wantedPublishAt({...e,date:'2030-03-11'},{now}),KEEP);
 assert.equal(wantedPublishAt({...e,status:'review'},{now}),'');
 assert.equal(wantedPublishAt({...e,timing:{mode:'at',date:e.date,time:e.time}},{now}),new Date(Date.parse('2030-03-13T15:00:00+03:00')).toISOString());
});

test('немедленный runner: старое автоматическое завтра не мешает; нет согласия, STOP и дубль защищены',async()=>{
 const raw={channel:'threads',kind:'thread',name:'immediate',material:'case:synthetic',date:'2030-03-13',time:'18:30',posts:['Покрытие проверяют у примыкания.']};
 const e=(await store.put(raw)).entry;let calls=0;
 _setAdapter('threads',{publish:async()=>{calls++;return {ok:true,id:'synthetic',link:'https://example.invalid/post'};}});
 assert.deepEqual((await runOnce({now})).published,[]);
 await store.transition(e.id,'review');await store.transition(e.id,'approved',{approval:{at:new Date(now).toISOString()}});
 setStop({by:'test'});assert.equal((await runOnce({now})).stopped,true);clearStop();assert.equal(calls,0);
 assert.deepEqual((await runOnce({now})).published,['immediate']);assert.equal(calls,1);
 await runOnce({now});assert.equal(calls,1);
});

test('режим сдачи не расширяет явно заданный законченный период',async()=>{
 const e=(await store.put({channel:'threads',kind:'thread',name:'period-ended',material:'case:synthetic',date:'2030-03-12',time:'10:00',timing:{mode:'period',from:'2030-03-12T10:00',to:'2030-03-12T11:00'},posts:['Кромки осматривают после укладки.']})).entry;
 await store.transition(e.id,'review');await store.transition(e.id,'approved',{approval:{at:new Date(now).toISOString()}});
 const r=await runOnce({now});assert.ok(r.waiting.includes(e.name));assert.equal(store.get(e.id).status,'approved');assert.match(store.get(e.id).note,/период закончился/);
});
