// Время. Расписание живёт по Москве: так его читают люди клиента и так стоят слоты.
// Сервер держим в UTC, все пересчёты здесь, чтобы «19:30» не значило разное в разных местах.

const MSK_OFFSET_MS = 3 * 3600_000;

/** Дата по Москве: «2026-10-15». */
export function mskDate(ms = Date.now()) {
  return new Date(ms + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

/** Час по Москве дробью: 22:30 → 22.5. */
export function mskHour(ms = Date.now()) {
  const d = new Date(ms + MSK_OFFSET_MS);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

/** «ЧЧ:ММ» по Москве. */
export function mskTime(ms = Date.now()) {
  return new Date(ms + MSK_OFFSET_MS).toISOString().slice(11, 16);
}

/** Когда запись должна выйти. NaN, если дата или время кривые. */
export function dueAt(entry) {
  return Date.parse(`${entry.date}T${entry.time}:00+03:00`);
}

/** «15.10 в 19:30» для сообщений людям. */
export function human(entry) {
  return `${entry.date.slice(8, 10)}.${entry.date.slice(5, 7)} в ${entry.time}`;
}

/** Сдвиг даты на N дней: «2026-10-15», +1 → «2026-10-16». */
export function addDays(date, days) {
  return mskDate(Date.parse(`${date}T12:00:00+03:00`) + days * 86_400_000);
}

/** Понедельник недели, в которую попадает момент: ключ недельных отчётов. */
export function weekStart(ms = Date.now()) {
  const d = new Date(ms + MSK_OFFSET_MS);
  const shift = (d.getUTCDay() + 6) % 7; // понедельник = 0
  return mskDate(ms - shift * 86_400_000);
}
