import test from 'node:test';import assert from 'node:assert/strict';
import {slotFor} from '../src/queue/slots.mjs';import {effectiveDue,requestedPeriodEnded} from '../src/queue/timing.mjs';
const cfg={perDay:1,minGapMin:600};
test('не раньше сохраняет нижнюю границу и не становится просроченным точным сроком',()=>{
 const entry={channel:'telegram',kind:'post',date:'2026-11-08',time:'12:00',timing:{mode:'not-before',date:'2026-11-08',time:'12:00',notBefore:'2026-11-08T09:00:00Z'}};
 const early=Date.parse('2026-11-08T08:00:00Z'),late=Date.parse('2026-11-08T10:00:00Z');
 assert.equal(effectiveDue(entry,early),Date.parse('2026-11-08T09:00:00Z'));assert.equal(slotFor(entry,[],cfg,early).time,'12:00');assert.equal(slotFor(entry,[],cfg,late).time,'13:00');assert.equal(requestedPeriodEnded(entry,late),false);
});
test('отдельный явный дедлайн не увеличивается, старое at без дедлайна не меняется',()=>{
 const e={timing:{mode:'at',expireAt:'2026-11-08T09:00:00Z'}};assert.equal(requestedPeriodEnded(e,Date.parse('2026-11-08T09:00:01Z')),true);assert.equal(requestedPeriodEnded({timing:{mode:'at'}},Date.parse('2026-11-08T09:00:01Z')),false);
});
test('at сохраняет точные секунды нижней границы и окно до конца назначенной минуты',()=>{
 const e={date:'2026-11-09',time:'14:30',timing:{mode:'at',atISO:'2026-11-09T11:30:30Z',expireAt:'2026-11-09T11:30:59.999Z'}};
 assert.equal(effectiveDue(e,Date.parse('2026-11-09T11:30:01Z')),Date.parse(e.timing.atISO));
 assert.equal(requestedPeriodEnded(e,Date.parse('2026-11-09T11:30:31Z')),false);assert.equal(requestedPeriodEnded(e,Date.parse('2026-11-09T11:31:00Z')),true);
 assert.equal(requestedPeriodEnded(e,Date.parse('2026-11-10T11:30:00Z')),true);
});
