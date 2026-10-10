// Рубильники выпуска: STOP, HOLD и перехват. Одно место, где они читаются и ставятся.
//
//   STOP           выпуск стоит целиком. Ставит утверждающий (/stop_release), оператор
//                  (npm run queue -- pause) либо перехват расписания компьютером;
//   HOLD           сервер молчал дольше получаса и вернулся: ждёт кнопки человека;
//   TAKEOVER.json  лежит на компьютере оператора: расписание ведёт он.
//
// ЗАЧЕМ У STOP ПРИЧИНА. Остановок две, и ведут они себя по-разному:
//  · человек сказал «стоп»: наружу не должно выйти ничего, включая ролики YouTube с
//    назначенной датой выхода. Включает выпуск тот же человек командой /start_release;
//  · расписание перехватил компьютер оператора: сервер молчит, а выпускает компьютер.
//    Включить сервер командой из группы в эту минуту значит получить двух выпускающих и
//    задвоенные посты. Такой STOP снимает только возврат: npm run mirror -- --handback.
// Пока причина была строкой для человека, сервер их не различал и в тревоге сам
// предлагал утверждающему команду, которая ведёт к дублям.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dataPath } from "../lib/env.mjs";

/**
 * Состояние рубильника STOP.
 * @returns {{ stopped: boolean, takeover: boolean, by: string, at: string, reason: string }}
 */
export function stopState() {
  const file = dataPath("STOP");
  if (!existsSync(file)) return { stopped: false, takeover: false, by: "", at: "", reason: "" };
  const text = readFileSync(file, "utf8");
  try {
    const s = JSON.parse(text);
    return { stopped: true, takeover: Boolean(s.takeover), by: String(s.by || ""), at: String(s.at || ""), reason: String(s.reason || "") };
  } catch {
    // Файл, положенный руками (touch STOP), тоже останавливает выпуск.
    return { stopped: true, takeover: /перехват/i.test(text), by: "", at: "", reason: text.trim().slice(0, 200) };
  }
}

/** Остановить выпуск. takeover — остановка ради перехвата расписания компьютером оператора. */
export function setStop({ by = "", reason = "", takeover = false } = {}) {
  const state = { at: new Date().toISOString(), by, reason, takeover: Boolean(takeover) };
  writeFileSync(dataPath("STOP"), JSON.stringify(state), "utf8");
  return state;
}

/** Снять STOP и HOLD. Возвращает имена снятых файлов. */
export function clearStop() {
  const removed = [];
  for (const f of ["STOP", "HOLD"]) {
    if (existsSync(dataPath(f))) { rmSync(dataPath(f)); removed.push(f); }
  }
  return removed;
}

export const isHeld = () => existsSync(dataPath("HOLD"));

/** Расписание ведёт этот компьютер (аварийный перехват). */
export const isTakeover = () => existsSync(dataPath("TAKEOVER.json"));
