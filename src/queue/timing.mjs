// Во время сдачи согласованные материалы выходят сразу. Только явное поручение
// о сроке удерживает выпуск; технические рубильники и ограничения API не меняются.
import {config} from '../lib/config.mjs';
import {dueAt} from '../lib/time.mjs';
export const commissioning=()=>config().release?.mode==='commissioning';
export const hasRequestedTime=e=>['at','period','not-before'].includes(e?.timing?.mode)||Number(e?.timing?.delayMin)>0;
export const requestedPeriodEnded=(entry,now=Date.now())=>(entry.timing?.mode==='period'&&now>Date.parse(entry.timing.to+':00+03:00'))||(entry.timing?.mode==='at'&&Boolean(entry.timing.expireAt)&&now>Date.parse(entry.timing.expireAt));
export function effectiveDue(entry,now=Date.now()){
 const due=entry.timing?.mode==='not-before'?Math.max(dueAt(entry),Date.parse(entry.timing.notBefore)):dueAt(entry);
 return commissioning()&&!hasRequestedTime(entry)?Math.min(due||now,now):due;
}
