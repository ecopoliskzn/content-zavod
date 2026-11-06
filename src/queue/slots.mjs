// Выход по постоянному решению оператора 06.11.2026: сразу после одобрения.
// Явный срок/период имеет приоритет, срочное ждёт только ближайшего прохода.
// Окно — свободное время с учётом дневного потолка, минимальной паузы и ночи,
// а не обязательное ожидание вечернего grid. Старая сетка оставлена как справочник.
//
// РОЛИК ИДЁТ СЛЕДОМ ЗА YOUTUBE. YouTube — основная видео-площадка: тот же ролик в
// Instagram, ВКонтакте и на Rutube выходит после него, а не до. Записи одного ролика на
// разных площадках носят одно имя, по нему и находится премьера.

import { dueAt, mskDate,mskTime, addDays } from "../lib/time.mjs";
import {config} from '../lib/config.mjs';
import {commissioning} from './timing.mjs';

const GONE = ["cancelled", "expired", "failed"];
const VIDEO_KINDS = ["video", "short", "reel"];

/** День недели даты по Москве: 1 понедельник … 7 воскресенье. */
export function weekday(date) {
  const d = new Date(Date.parse(`${date}T12:00:00+03:00`)).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Правило сетки площадки для вида записи: часы и дни, по которым запись встаёт сама. */
export function gridFor(channelCfg, kind = "") {
  const rules = Array.isArray(channelCfg.grid) ? channelCfg.grid : channelCfg.grid ? [channelCfg.grid] : [];
  const rule = rules.find((r) => (r.kinds || []).includes(kind)) || rules.find((r) => !r.kinds) || {};
  const slots = [...(rule.slots?.length ? rule.slots : channelCfg.slots || [])].sort();
  return { slots, weekdays: rule.weekdays?.length ? rule.weekdays : null };
}

/**
 * Ближайший свободный слот площадки после момента after.
 * @param {{ slots: string[], perDay: number, grid?: object|object[] }} channelCfg
 * @param {Array<{ date: string, time: string, status: string, id: string, kind?: string }>} taken записи этой площадки
 * @param {number} after момент, раньше которого слот не годится (мс)
 * @param {string} [selfId] номер переставляемой записи: свой слот занятым не считается
 * @param {string} [kind] вид записи: у видео во ВКонтакте своя строка сетки
 */
export function nextSlot(channelCfg, taken, after = Date.now(), selfId = "", kind = "") {
  const { slots, weekdays } = gridFor(channelCfg, kind);
  if (!slots.length) return null;
  // Ответ на комментарий слота не занимает: он уходит сотруднику сразу после согласования.
  const busy = taken.filter((e) => e.id !== selfId && e.kind !== "reply" && !GONE.includes(e.status));
  const key = (e) => `${e.date} ${e.time}`;
  const occupied = new Set(busy.map(key));
  const perDay = channelCfg.perDay || slots.length;
  let date = mskDate(after);
  for (let day = 0; day < 60; day++, date = addDays(date, 1)) {
    if (weekdays && !weekdays.includes(weekday(date))) continue;
    const today = busy.filter((e) => e.date === date).length;
    if (today >= perDay) continue;
    for (const time of slots) {
      const candidate = { date, time };
      // Запас четверть часа: человеку нужно время увидеть карточку, выпуску — проход.
      if (dueAt(candidate) < after + 15 * 60_000) continue;
      if (occupied.has(key(candidate))) continue;
      return candidate;
    }
  }
  return null;
}

/** Занят ли слот другой записью той же площадки. */
export function slotTaken(taken, date, time, selfId = "") {
  return taken.some((e) => e.id !== selfId && e.kind !== "reply" && e.date === date && e.time === time && !GONE.includes(e.status));
}

/**
 * Когда этот же ролик выходит на YouTube (мс) либо 0, если премьеры в очереди нет.
 * Нужно записям Instagram, ВКонтакте и Rutube: раньше премьеры они не встают.
 * @param {object[]} entries вся очередь
 * @param {{ channel: string, kind: string, name: string }} entry
 */
export function premiereOf(entries, entry, now=Date.now()) {
  if (entry.channel === "youtube" || !VIDEO_KINDS.includes(entry.kind) || !entry.name) return 0;
  const first = entries.find((e) => e.channel === "youtube" && e.name === entry.name && e.status !== "cancelled");
  if(!first)return 0;
  if(first.status==='published')return Date.parse(first.publishedAt)||dueAt(first)||0;
  // Дата старой сетки не является волей оператора. Выпуск всё равно проверит,
  // что YouTube действительно вышел, прежде чем открывать остальные площадки.
  return ['at','period'].includes(first.timing?.mode)||['approved','running'].includes(first.status)?dueAt(first)||now:now;
}

/**
 * Ближайший слот для записи: по рабочей сетке площадки и не раньше премьеры на YouTube.
 * Одна функция на постановку, перестановку и кнопки в группе, чтобы слот считался одинаково.
 * @param {object} entry запись (нужны channel, kind, name, id)
 * @param {object[]} entries вся очередь
 * @param {object} channelCfg настройки площадки записи
 */
export function slotFor(entry, entries, channelCfg, now = Date.now()) {
  const timing=requestTiming(entry),rules=config().release||{},minute=60000;
  const delay=(timing.delayMin??0)*minute;
  const priorApproval=['approved','failed','expired'].includes(entry.status)&&Date.parse(entry.approval?.at);
  let earliest=delay?Math.max(now,(priorApproval||now)+delay):Math.floor(now/minute)*minute,latest=now+60*86400000;
  if(timing.mode==='urgent')earliest=Math.floor(now/minute)*minute;
  if(timing.mode==='at'){const wanted=dueAt(timing);earliest=wanted>=now?wanted:Math.floor(now/minute)*minute;latest=earliest;}
  if(timing.mode==='period'){earliest=Math.max(now,operatorMoment(timing.from));latest=operatorMoment(timing.to);}
  const premiere=premiereOf(entries,entry,now);if(premiere)earliest=Math.max(earliest,premiere+(commissioning()?0:minute));
  if(!['at','period'].includes(timing.mode))latest=Math.max(now,earliest)+60*86400000;
  if(commissioning())return earliest<=latest?{date:mskDate(earliest),time:mskTime(earliest)}:null;
  let candidate=Math.ceil(earliest/minute)*minute;
  const busy=entries.filter(e=>e.channel===entry.channel&&e.id!==entry.id&&e.kind!=='reply'&&!GONE.includes(e.status)&&!sameStorySeries(entry,e));
  const gap=Math.max(1,Number(channelCfg.minGapMin)||0)*minute;
  const open=(rules.nightToHour??7)*60,close=(rules.nightFromHour??22.5)*60;
  for(let n=0;n<60*1440&&candidate<=latest;n++){
    const date=mskDate(candidate),start=dueAt({date,time:'00:00'}),minutes=(candidate-start)/minute;
    if(minutes<open){candidate=start+open*minute;continue;}
    if(minutes>=close){candidate=dueAt({date:addDays(date,1),time:'00:00'})+open*minute;continue;}
    const units=new Set(busy.filter(e=>e.date===date).map(e=>e.kind==='story'&&e.material?'stories:'+e.material:e.id));
    if(channelCfg.perDay&&units.size>=channelCfg.perDay){candidate=dueAt({date:addDays(date,1),time:'00:00'})+open*minute;continue;}
    const conflict=busy.find(e=>Math.abs((e.publishedAt?Date.parse(e.publishedAt):dueAt(e))-candidate)<gap);
    if(conflict){candidate=Math.ceil(((conflict.publishedAt?Date.parse(conflict.publishedAt):dueAt(conflict))+gap)/minute)*minute;continue;}
    return {date,time:mskTime(candidate)};
  }
  return null;
}

/** Одобренные кадры одного материала — одна серия, между ними пауза постов не нужна. */
export const sameStorySeries=(a,b)=>a?.channel==='instagram'&&b?.channel==='instagram'&&a.kind==='story'&&b.kind==='story'&&Boolean(a.material)&&a.material===b.material;

function operatorMoment(value){
  const str=String(value||''),ms=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(str)?Date.parse(str+':00+03:00'):NaN;
  if(!Number.isFinite(ms)||mskDate(ms)+'T'+mskTime(ms)!==str)throw Object.assign(new Error('период: нужен точный срок ГГГГ-ММ-ДДTЧЧ:ММ по Москве'),{code:'RULE'});
  return ms;
}

/** Явные флаги оператора перекрывают сохранённое пожелание времени. */
export function requestTiming(entry,args={}){
  let timing;
  if(args.now||args.urgent)timing={mode:'urgent'};
  else if(args.from||args.to)timing={mode:'period',from:args.from,to:args.to};
  else if(args.date||args.time)timing={mode:'at',date:args.date||entry.date,time:args.time||entry.time};
  else if(args.delay!==undefined)timing={mode:'after-approval',delayMin:Number(args.delay)};
  else if(args.next)timing={mode:'after-approval'};
  else timing=entry.timing||{mode:'after-approval'};
  if(!['urgent','at','period','after-approval'].includes(timing.mode))throw Object.assign(new Error('неизвестный способ выбора срока'),{code:'RULE'});
  if(timing.delayMin!==undefined&&(!Number.isSafeInteger(timing.delayMin)||timing.delayMin<0||timing.delayMin>10080))throw Object.assign(new Error('задержка: целое число минут от 0 до 10080'),{code:'RULE'});
  if(timing.mode==='at')operatorMoment(timing.date+'T'+timing.time);
  if(timing.mode==='period'&&operatorMoment(timing.from)>operatorMoment(timing.to))throw Object.assign(new Error('начало периода позже конца'),{code:'RULE'});
  return {...timing};
}

/** Записи того же ролика на других площадках, которые стоят не позже премьеры на YouTube. */
export function aheadOfPremiere(entries, premiere) {
  if (premiere?.channel !== "youtube") return [];
  const due = dueAt(premiere);
  return entries.filter((e) => e.channel !== "youtube" && e.name === premiere.name && VIDEO_KINDS.includes(e.kind) && !GONE.includes(e.status) && !["published", "handed", "running"].includes(e.status) && dueAt(e) <= due);
}
