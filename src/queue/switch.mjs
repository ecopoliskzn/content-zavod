// Рубильники выпуска: STOP, HOLD, RESTORED и перехват. Одно место, где они читаются и ставятся.
//
//   STOP           выпуск стоит целиком. Ставит утверждающий (/stop_release), оператор
//                  (npm run queue -- pause) либо перехват расписания компьютером;
//   HOLD           сервер молчал дольше получаса и вернулся: ждёт кнопки человека;
//   RESTORED       каталог данных развёрнут из архива: расписание в нём старше копии на
//                  компьютере оператора, выпуск стоит до сверки с копией;
//   TAKEOVER.json  лежит на компьютере оператора: расписание ведёт он.
//
// В ФАЙЛЕ STOP ТРИ ОТМЕТКИ, И ОНИ НЕЗАВИСИМЫ.
//   human     человек сказал «стоп»: наружу не должно выйти ничего, включая ролики
//             YouTube с назначенной датой выхода. Снимает её только человек:
//             /start_release в группе либо npm run queue -- resume;
//   takeover  расписание перехватил компьютер оператора: сервер молчит, а выпускает
//             компьютер. Снимает её только возврат: npm run mirror -- --handback;
//   handback  ставится на компьютере оператора на время возврата расписания серверу:
//             пока передаётся сделанное, компьютер не выпускает. Снимает её отмена
//             возврата: npm run queue -- resume --local.
// Выпуск стоит, пока стоит хотя бы одна.
//
// Почему отметки раздельные, а не одна с причиной. С одной отметкой перехват затирал
// остановку человека: утверждающий сказал «стоп», оператор перехватил расписание, и
// компьютер выпускал одобренное, а возврат включал сервер, хотя «старт» никто не давал.
// Третья отметка появилась по той же причине: возврат писал свою причину поверх слова
// человека, и отмена возврата это слово снимала.

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dataPath } from "../lib/env.mjs";
import { writeAtomic } from "../lib/files.mjs";

const KINDS = ["human", "takeover", "handback"];
const NONE = () => ({ human: null, takeover: null, handback: null });
const mark = (v) => (v && typeof v === "object" ? { by: String(v.by || ""), at: String(v.at || ""), reason: String(v.reason || "") } : null);

/** Причина местной остановки, принятой компьютером оператора с сервера при перехвате. */
export const ADOPTED_STOP = "выпуск остановлен человеком на сервере";

function read() {
  const file = dataPath("STOP");
  if (!existsSync(file)) return NONE();
  const text = readFileSync(file, "utf8");
  let s;
  let parsed = true;
  try { s = JSON.parse(text); } catch { parsed = false; }
  if (parsed && s && typeof s === "object" && !Array.isArray(s)) {
    const got = { human: mark(s.human), takeover: mark(s.takeover), handback: mark(s.handback) };
    if (KINDS.some((k) => got[k])) return got;
    // Файл прежнего вида: одна отметка с причиной и признаком перехвата.
    const old = { by: String(s.by || ""), at: String(s.at || ""), reason: String(s.reason || "") };
    if (s.takeover === true) return { ...NONE(), takeover: old };
    if (old.by || old.at || old.reason) return { ...NONE(), human: old };
  }
  /* Файл есть, а отметок в нём не разобрать: пустой, «{}», положен руками. Выпуск стоит
     как по слову человека. Обратное было бы хуже: доктор и /health говорят «остановлен»
     по наличию файла, а выпуск шёл бы. */
  return { ...NONE(), human: { by: "", at: "", reason: (parsed ? "" : text.trim().slice(0, 200)) || "файл STOP положен руками" } };
}

function write(state) {
  const file = dataPath("STOP");
  if (!KINDS.some((k) => state[k])) { if (existsSync(file)) rmSync(file); return; }
  // Замена, а не перезапись: файл STOP, положенный руками под другим пользователем,
  // перезаписать нельзя, а заменить можно.
  writeAtomic(file, JSON.stringify(state));
}

/**
 * Состояние рубильника STOP.
 * @returns {{ stopped: boolean, human: boolean, takeover: boolean, handback: boolean, by: string, at: string, reason: string }}
 *   by, at, reason — от остановки человеком; если её нет, от возврата, затем от перехвата
 */
export function stopState() {
  const s = read();
  const lead = s.human || s.handback || s.takeover || { by: "", at: "", reason: "" };
  return { stopped: KINDS.some((k) => s[k]), human: Boolean(s.human), takeover: Boolean(s.takeover), handback: Boolean(s.handback), by: lead.by, at: lead.at, reason: lead.reason };
}

const kindOf = ({ takeover = false, handback = false }) => (takeover ? "takeover" : handback ? "handback" : "human");

/** Поставить отметку: человека (по умолчанию), перехвата либо возврата. Остальные не трогаются. */
export function setStop({ by = "", reason = "", takeover = false, handback = false } = {}) {
  const s = read();
  s[kindOf({ takeover, handback })] = { by, at: new Date().toISOString(), reason };
  write(s);
  return stopState();
}

/**
 * Снять отметку: человека (по умолчанию), перехвата, возврата либо все (all — только для
 * местного каталога компьютера оператора в начале перехвата). Возвращает состояние после снятия.
 */
export function clearStop({ takeover = false, handback = false, all = false } = {}) {
  const s = read();
  if (all) for (const k of KINDS) s[k] = null;
  else s[kindOf({ takeover, handback })] = null;
  write(s);
  return stopState();
}

export const isHeld = () => existsSync(dataPath("HOLD"));

/** Снять удержание после простоя. */
export function clearHold() {
  if (existsSync(dataPath("HOLD"))) rmSync(dataPath("HOLD"));
}

/**
 * Каталог данных развёрнут из архива. Файл RESTORED кладёт в архив скрипт резервной копии;
 * в живом каталоге его нет, он появляется только после восстановления. Снимает его сверка
 * с копией расписания (npm run mirror -- --reconcile либо возврат после перехвата).
 */
export const isRestored = () => existsSync(dataPath("RESTORED"));

/** Поставить отметку «расписание старше копии»: выпуск встаёт до сверки. */
export function setRestored(info = {}) {
  writeAtomic(dataPath("RESTORED"), JSON.stringify({ at: new Date().toISOString(), ...info }));
}

export function clearRestored() {
  if (existsSync(dataPath("RESTORED"))) rmSync(dataPath("RESTORED"));
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
