import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
process.env.DATA_DIR=mkdtempSync(path.join(tmpdir(),'scheduling-'));process.env.ZAVOD_ENV_FILE=path.join(process.env.DATA_DIR,'absent.env');
const slots=await import('../src/queue/slots.mjs');const store=await import('../src/queue/store.mjs');
const {config}=await import('../src/lib/config.mjs');config().release.mode='scheduled';
const t=s=>Date.parse('2030-06-03T'+s+':00+03:00'),cfg={slots:['18:30'],grid:{slots:['18:30']},perDay:3,minGapMin:40};
const entry={id:'a',channel:'instagram',kind:'carousel',name:'test',timing:{mode:'after-approval'}};
test('по правилу 06.11 обычный срок сразу после одобрения, без вечерней сетки',()=>{assert.deepEqual(slots.slotFor(entry,[],cfg,t('10:00')),{date:'2030-06-03',time:'10:00'});assert.equal(slots.slotFor({...entry,timing:{mode:'after-approval',delayMin:30}},[],cfg,t('10:00')).time,'10:30');});
test('конфликт учитывает минимальный разрыв и дневной предел',()=>{
 const busy=[{id:'b',channel:'instagram',date:'2030-06-03',time:'10:00',status:'approved'}];
 assert.deepEqual(slots.slotFor(entry,busy,cfg,t('10:00')),{date:'2030-06-03',time:'10:40'});
 assert.deepEqual(slots.slotFor(entry,busy,{...cfg,perDay:1},t('10:00')),{date:'2030-06-04',time:'07:00'});
});
test('явный срок и период приоритетны, прошедший период не растягивается молча',()=>{
 assert.equal(slots.slotFor({...entry,timing:{mode:'at',date:'2030-06-03',time:'10:10'}},[],cfg,t('10:00')).time,'10:10');
 const period={mode:'period',from:'2030-06-03T10:10',to:'2030-06-03T10:20'};
 assert.equal(slots.slotFor({...entry,timing:period},[],cfg,t('10:00')).time,'10:10');
 assert.equal(slots.slotFor({...entry,timing:period},[{id:'b',channel:'instagram',date:'2030-06-03',time:'10:10',status:'approved'}],cfg,t('10:00')),null);
 assert.equal(slots.slotFor({...entry,timing:period},[],cfg,t('11:00')),null);
});
test('срочное не получает искусственных 30 минут, ночное ограничение сохранено',()=>{
 assert.equal(slots.slotFor({...entry,timing:{mode:'urgent'}},[],cfg,t('10:00')).time,'10:00');
 assert.equal(slots.slotFor({...entry,timing:{mode:'urgent'}},[],cfg,t('06:00')).time,'07:00');
});
test('позднее одобрение пересчитывает немедленный срок от нового согласия',async()=>{
 const e=(await store.put({channel:'telegram',kind:'post',name:'late-approval',material:'blog:synthetic',text:'Примыкания проверяют после укладки.',date:'2030-06-03',time:'10:30',timing:{mode:'after-approval'}})).entry;
 await store.transition(e.id,'review');const r=await store.approveEntry(e.id,{at:new Date(t('12:00')).toISOString()},'test',{},t('12:00'));
 assert.equal(r.time,'12:00');assert.equal(r.status,'approved');
});
test('приоритет команд: сейчас, заданный срок, период и стандартный следующий',()=>{
 assert.equal(slots.requestTiming({...entry,date:'2030-06-03',time:'18:30'},{now:true}).mode,'urgent');
 assert.deepEqual(slots.requestTiming(entry,{date:'2030-06-03',time:'11:00'}),{mode:'at',date:'2030-06-03',time:'11:00'});
 assert.equal(slots.requestTiming(entry,{from:'2030-06-03T10:00',to:'2030-06-03T11:00'}).mode,'period');
 assert.equal(slots.requestTiming({...entry,timing:{mode:'urgent'}},{next:true}).mode,'after-approval');
 assert.equal(slots.requestTiming(entry,{delay:30}).delayMin,30);
});

test('старая вычисленная дата не становится поручением ждать завтра',async()=>{
 const legacy={channel:'vk',kind:'post',name:'legacy-tomorrow',material:'blog:synthetic',text:'Проверка основания.',date:'2030-06-04',time:'15:00'};
 assert.deepEqual(slots.requestTiming(legacy),{mode:'after-approval'});
 assert.equal(slots.slotFor(legacy,[],cfg,t('10:00')).date,'2030-06-03');
 const e=(await store.put(legacy)).entry;await store.transition(e.id,'review');
 const approved=await store.approveEntry(e.id,{at:new Date(t('10:00')).toISOString()},'test',{},t('10:00'));
 assert.equal(approved.date,'2030-06-03');assert.equal(approved.time,'10:00');
 assert.equal(approved.contentHash,e.contentHash);
});

test('явное завтра сохраняется, занятый точный срок не переносится молча',()=>{
 const explicit={...entry,timing:{mode:'at',date:'2030-06-04',time:'15:00'}};
 assert.deepEqual(slots.slotFor(explicit,[],cfg,t('10:00')),{date:'2030-06-04',time:'15:00'});
 assert.equal(slots.slotFor(explicit,[{id:'busy',channel:'instagram',date:'2030-06-04',time:'15:00',status:'approved'}],cfg,t('10:00')),null);
 assert.equal(slots.slotFor({...entry,timing:{mode:'at',date:'2030-06-03',time:'06:00'}},[],cfg,t('05:00')),null);
});

test('ролик после YouTube не наследует его старое автоматическое завтра',()=>{
 const first={id:'yt',channel:'youtube',kind:'short',name:'test',status:'review',date:'2030-06-04',time:'15:00'};
 assert.equal(slots.slotFor({...entry,kind:'reel'},[first],cfg,t('10:00')).date,'2030-06-03');
});

test('технический повтор не начинает уже прошедшую задержку заново',()=>{
 const failed={...entry,status:'failed',approval:{at:new Date(t('09:00')).toISOString()},timing:{mode:'after-approval',delayMin:30}};
 assert.equal(slots.slotFor(failed,[],cfg,t('10:00')).time,'10:00');
});

test('кадры Stories одного материала не получают интервал обычных постов',()=>{
 const frame={...entry,kind:'story',material:'case:story-series'};
 const taken=[{...frame,id:'frame-1',status:'approved',date:'2030-06-03',time:'10:00'}];
 assert.equal(slots.slotFor(frame,taken,{...cfg,perDay:1,minGapMin:180},t('10:00')).time,'10:00');
});
