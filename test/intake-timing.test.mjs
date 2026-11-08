import test from 'node:test';import assert from 'node:assert/strict';
import {slotFor} from '../src/queue/slots.mjs';import {effectiveDue,requestedPeriodEnded} from '../src/queue/timing.mjs';
const cfg={perDay:1,minGapMin:600};
test('не раньше сохраняет нижнюю границу и не становится просроченным точным сроком',()=>{
 const entry={channel:'telegram',kind:'post',date:'2026-11-08',time:'12:00',timing:{mode:'not-before',date:'2026-11-08',time:'12:00',notBefore:'2026-11-08T09:00:00Z'}};
 const early=Date.parse('2026-11-08T08:00:00Z'),late=Date.parse('2026-11-08T10:00:00Z');
 assert.equal(effectiveDue(entry,early),Date.parse('2026-11-08T09:00:00Z'));assert.equal(slotFor(entry,[],cfg,early).time,'12:00');assert.equal(slotFor(entry,[],cfg,late).time,'13:00');assert.equal(requestedPeriodEnded(entry,late),false);
});
test('явный точный срок приёмника истёк до согласия, старое at других записей не меняется',()=>{
 const e={timing:{mode:'at',expireAt:'2026-11-08T09:00:00Z'}};assert.equal(requestedPeriodEnded(e,Date.parse('2026-11-08T09:00:01Z')),true);assert.equal(requestedPeriodEnded({timing:{mode:'at'}},Date.parse('2026-11-08T09:00:01Z')),false);
});
