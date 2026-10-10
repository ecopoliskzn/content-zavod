// Слоты выхода. У каждой площадки своя сетка времени в zavod.config.json.
//
// Зачем сетка, а не «выпусти через час». Расписание читают люди клиента, и предсказуемые
// часы проще согласовывать. А ещё есть замер: у Threads вечерние слоты 19–21 давали
// медиану 196 просмотров против 69 у слотов 11–13. Сетку поэтому правят по цифрам
// недельного отчёта, а не на глаз.
//
// ДВА СПИСКА У ПЛОЩАДКИ, и это разные вещи:
//   slots — в какие часы площадка вообще может выпускать. Потолок;
//   grid  — рабочая сетка: в какие из этих часов и по каким дням запись встаёт сама.
// Без второго списка план «две ветки в день, ролик трижды в неделю» жил только в
// документе: постановка брала ближайший свободный слот из всех, и четыре ветки, написанные
// за одну сессию, вставали на один день. Время, указанное руками (--date, --time), сетку
// обходит: так ставят срочное.
//
// РОЛИК ИДЁТ СЛЕДОМ ЗА YOUTUBE. YouTube — основная видео-площадка: тот же ролик в
// Instagram, ВКонтакте и на Rutube выходит после него, а не до. Записи одного ролика на
// разных площадках носят одно имя, по нему и находится премьера.

import { dueAt, mskDate, addDays } from "../lib/time.mjs";

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
export function premiereOf(entries, entry) {
  if (entry.channel === "youtube" || !VIDEO_KINDS.includes(entry.kind) || !entry.name) return 0;
  const first = entries.find((e) => e.channel === "youtube" && e.name === entry.name && e.status !== "cancelled");
  return first ? dueAt(first) || 0 : 0;
}

/**
 * Ближайший слот для записи: по рабочей сетке площадки и не раньше премьеры на YouTube.
 * Одна функция на постановку, перестановку и кнопки в группе, чтобы слот считался одинаково.
 * @param {object} entry запись (нужны channel, kind, name, id)
 * @param {object[]} entries вся очередь
 * @param {object} channelCfg настройки площадки записи
 */
export function slotFor(entry, entries, channelCfg, now = Date.now()) {
  const premiere = premiereOf(entries, entry);
  // Слот берётся с запасом в четверть часа от момента after, поэтому от премьеры
  // отступаем на 14 минут назад: ролик встанет не раньше чем через минуту после неё.
  const after = Math.max(now, premiere ? premiere - 14 * 60_000 : 0);
  return nextSlot(channelCfg, entries.filter((e) => e.channel === entry.channel), after, entry.id, entry.kind);
}

/** Записи того же ролика на других площадках, которые стоят не позже премьеры на YouTube. */
export function aheadOfPremiere(entries, premiere) {
  if (premiere?.channel !== "youtube") return [];
  const due = dueAt(premiere);
  return entries.filter((e) => e.channel !== "youtube" && e.name === premiere.name && VIDEO_KINDS.includes(e.kind) && !GONE.includes(e.status) && !["published", "handed", "running"].includes(e.status) && dueAt(e) <= due);
}
