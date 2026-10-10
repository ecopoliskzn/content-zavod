// Рубильники выпуска: STOP, HOLD и перехват. Одно место, где они читаются и ставятся.
//
//   STOP           выпуск стоит целиком. Ставит утверждающий (/stop_release), оператор
//                  (npm run queue -- pause) либо перехват расписания компьютером;
//   HOLD           сервер молчал дольше получаса и вернулся: ждёт кнопки человека;
//   TAKEOVER.json  лежит на компьютере оператора: расписание ведёт он.
//
// В ФАЙЛЕ STOP ДВЕ ОТМЕТКИ, И ОНИ НЕЗАВИСИМЫ.
//   human     человек сказал «стоп»: наружу не должно выйти ничего, включая ролики
//             YouTube с назначенной датой выхода. Снимает её только человек:
//             /start_release в группе либо npm run queue -- resume;
//   takeover  расписание перехватил компьютер оператора: сервер молчит, а выпускает
//             компьютер. Снимает её только возврат: npm run mirror -- --handback.
// Выпуск стоит, пока стоит хотя бы одна.
//
// Почему отметок две, а не одна с причиной. С одной отметкой перехват затирал остановку
// человека: утверждающий сказал «стоп», оператор перехватил расписание, и компьютер
// выпускал одобренное, а возврат включал сервер, хотя «старт» никто не давал. И обратно:
// команда оператора во время перехвата превращала остановку в обычную, и одно слово из
// рабочей группы включало второго выпускающего.

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dataPath } from "../lib/env.mjs";
import { writeAtomic } from "../lib/files.mjs";

const mark = (v) => (v && typeof v === "object" ? { by: String(v.by || ""), at: String(v.at || ""), reason: String(v.reason || "") } : null);

function read() {
  const file = dataPath("STOP");
  if (!existsSync(file)) return { human: null, takeover: null };
  const text = readFileSync(file, "utf8");
  try {
    const s = JSON.parse(text);
    if (s && typeof s === "object") return { human: mark(s.human), takeover: mark(s.takeover) };
  } catch { /* не JSON: файл положен руками */ }
  // Файл, положенный руками (touch STOP), останавливает выпуск как слово человека.
  return { human: { by: "", at: "", reason: text.trim().slice(0, 200) || "файл STOP положен руками" }, takeover: null };
}

function write(state) {
  const file = dataPath("STOP");
  if (!state.human && !state.takeover) { if (existsSync(file)) rmSync(file); return; }
  // Замена, а не перезапись: файл STOP, положенный руками под другим пользователем,
  // перезаписать нельзя, а заменить можно.
  writeAtomic(file, JSON.stringify(state));
}

/**
 * Состояние рубильника STOP.
 * @returns {{ stopped: boolean, human: boolean, takeover: boolean, by: string, at: string, reason: string }}
 *   by, at, reason — от остановки человеком, а если её нет, от перехвата
 */
export function stopState() {
  const s = read();
  const lead = s.human || s.takeover || { by: "", at: "", reason: "" };
  return { stopped: Boolean(s.human || s.takeover), human: Boolean(s.human), takeover: Boolean(s.takeover), by: lead.by, at: lead.at, reason: lead.reason };
}

/** Поставить отметку: человека (по умолчанию) либо перехвата. Вторая отметка не трогается. */
export function setStop({ by = "", reason = "", takeover = false } = {}) {
  const s = read();
  s[takeover ? "takeover" : "human"] = { by, at: new Date().toISOString(), reason };
  write(s);
  return stopState();
}

/**
 * Снять отметку: человека (по умолчанию), перехвата либо обе (all — только для местного
 * каталога компьютера оператора в начале перехвата). Возвращает состояние после снятия.
 */
export function clearStop({ takeover = false, all = false } = {}) {
  const s = read();
  if (all) { s.human = null; s.takeover = null; } else s[takeover ? "takeover" : "human"] = null;
  write(s);
  return stopState();
}

export const isHeld = () => existsSync(dataPath("HOLD"));

/** Снять удержание после простоя. */
export function clearHold() {
  if (existsSync(dataPath("HOLD"))) rmSync(dataPath("HOLD"));
}

/** Расписание ведёт этот компьютер (аварийный перехват). */
export const isTakeover = () => existsSync(dataPath("TAKEOVER.json"));

/**
 * Идёт ли прямо сейчас проход выпуска: стоит свежий замок. Замок старше двадцати минут
 * остался от упавшего процесса, его перехватит следующий проход.
 */
export function runnerBusy(staleMs = 20 * 60_000) {
  try { return Date.now() - statSync(dataPath("runner.lock")).mtimeMs < staleMs; } catch { return false; }
}
