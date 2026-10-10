// Heartbeat фоновых циклов бота (воронка v2, BOT-ALYONA-FUNNEL-V2, раздел "HEARTBEAT").
// Тот же урок, что и у kormishin scripts/heartbeat.mjs (D:\CODE\kormishin-site, только для
// чтения): «нет разницы между "прошло хорошо" и "не запускалось вовсе"» — молчаливая
// остановка setInterval'а (igQueuePoll/followupPoll в apps/bot-alyona/server.mjs) выглядит
// как «всё тихо», а не как «сломалось», и неделя простоя читается как «лидов просто нет».
//
// Здесь — только запись/чтение файла (generic, без бизнес-логики конкретного инстанса):
// каждый цикл отмечается ПОСЛЕ каждого прохода, и когда прошло хорошо, и когда упало.
// Файл, а не память процесса: /health должен уметь отдать сводку сразу после рестарта
// процесса тоже (сама история до рестарта, конечно, теряется — это ок, копится заново).
//
// Форма файла — {<loop>: {lastRun, lastOk, lastError}}, как задано планом; сравнение
// "успех vs всего лишь прошёл" — тем же приёмом, что у kormishin (lastOk отдельно от
// lastRun): воркер может исправно отмечаться сбоями каждый раз, и без lastOk summary()
// показал бы "след минуту назад" у цикла, который на самом деле не работает третьи сутки.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * @param {object} опции
 * @param {string} опции.file путь к heartbeat.json (обычно path.join(storageDir, "heartbeat.json"))
 */
export function createHeartbeat({ file } = {}) {
  if (!file) throw new TypeError("createHeartbeat: нужен file");

  function читать() {
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return {}; // битый файл не должен ронять запись следующего тика
    }
  }

  function писать(д) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(д, null, 1) + "\n");
  }

  /**
   * Отмечает проход цикла: успех (error не передан/пуст) или сбой (error — сообщение).
   * @param {string} loop имя цикла: igQueuePoll, followupPoll, …
   * @param {string|Error} [error] причина сбоя; без неё — цикл прошёл хорошо
   */
  function record(loop, error) {
    if (!loop) throw new TypeError("heartbeat.record: нужно имя цикла");
    const д = читать();
    const сейчас = new Date().toISOString();
    const было = д[loop] || {};
    const сообщение = error ? (error instanceof Error ? error.message : String(error)).slice(0, 300) : null;
    д[loop] = {
      lastRun: сейчас,
      lastOk: сообщение ? (было.lastOk ?? null) : сейчас,
      lastError: сообщение,
    };
    писать(д);
    return д[loop];
  }

  /** Полное состояние (для отладки/тестов) — как записано в файле. */
  function state() {
    return читать();
  }

  /** Компактная сводка для /health: по каждому циклу — жив ли (нет lastError) и сколько
   *  секунд назад был последний проход (не важно, успешный или нет — сам факт, что цикл
   *  вообще шевелится). */
  function summary() {
    const д = читать();
    return Object.fromEntries(
      Object.entries(д).map(([loop, в]) => [
        loop,
        {
          ok: !в.lastError,
          ageSec: в.lastRun ? Math.round((Date.now() - Date.parse(в.lastRun)) / 1000) : null,
          lastError: в.lastError ?? null,
        },
      ]),
    );
  }

  return { record, state, summary, file };
}
