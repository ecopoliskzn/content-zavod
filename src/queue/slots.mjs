// Слоты выхода. У каждой площадки своя сетка времени в zavod.config.json.
//
// Зачем сетка, а не «выпусти через час». Расписание читают люди клиента, и предсказуемые
// часы проще согласовывать. А ещё есть замер: у Threads вечерние слоты 19–21 давали
// медиану 196 просмотров против 69 у слотов 11–13. Сетку поэтому правят по цифрам
// недельного отчёта, а не на глаз.

import { dueAt, mskDate, addDays } from "../lib/time.mjs";

/**
 * Ближайший свободный слот площадки после момента after.
 * @param {{ slots: string[], perDay: number }} channelCfg
 * @param {Array<{ date: string, time: string, status: string, id: string }>} taken записи этой площадки
 * @param {number} after момент, раньше которого слот не годится (мс)
 * @param {string} [selfId] номер переставляемой записи: свой слот занятым не считается
 */
export function nextSlot(channelCfg, taken, after = Date.now(), selfId = "") {
  const slots = [...(channelCfg.slots || [])].sort();
  if (!slots.length) return null;
  const busy = taken.filter((e) => e.id !== selfId && !["cancelled", "expired", "failed"].includes(e.status));
  const key = (e) => `${e.date} ${e.time}`;
  const occupied = new Set(busy.map(key));
  const perDay = channelCfg.perDay || slots.length;
  let date = mskDate(after);
  for (let day = 0; day < 30; day++, date = addDays(date, 1)) {
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
  return taken.some((e) => e.id !== selfId && e.date === date && e.time === time && !["cancelled", "expired", "failed"].includes(e.status));
}
