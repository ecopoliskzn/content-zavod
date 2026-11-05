// Очередь выпуска: хранилище. ЕДИНСТВЕННЫЙ ПИСАТЕЛЬ файла queue.jsonl.
//
// В очередь пишут трое: сессии Codex (ставят черновики), бот (кнопки согласования) и
// выпуск по расписанию (отмечает «выходит» и «вышло»). Если каждый правит файл по-своему,
// один затирает правку другого: теряется согласование или пост выходит дважды, а снять
// вышедший пост площадка не даёт. Поэтому правило жёсткое: имя файла очереди встречается
// только здесь, все остальные зовут этот модуль.
//
// Как устроено:
//  · журнал только дописывается, по номеру записи побеждает последняя строка;
//  · каждая запись в журнал идёт под замком и ПЕРЕЧИТЫВАЕТ текущее состояние: выпуск,
//    взявший запись секунду назад, не перепишет «снято», поставленное кнопкой;
//  · переход статуса проверяется по таблице из format.mjs. Недопустимый переход — отказ
//    по правилу (RuleError), а не исключение окружения.

import { existsSync } from "node:fs";
import { dataPath } from "../lib/env.mjs";
import { appendJsonl, latestById, lock, readJsonl, writeAtomic } from "../lib/files.mjs";
import { sleep } from "../lib/http.mjs";
import { canMove, contentHash, entryHash, isFinal, normalize, validate } from "./format.mjs";

export class RuleError extends Error {
  constructor(message) {
    super(message);
    this.code = "RULE";
  }
}

const FILE = () => dataPath("queue.jsonl");
const LOCK = () => dataPath("queue.lock");

async function withLock(fn) {
  for (let i = 0; i < 200; i++) {
    const release = lock(LOCK(), 60_000);
    if (release) {
      try { return await fn(); } finally { release(); }
    }
    await sleep(50);
  }
  throw Object.assign(new Error("очередь занята дольше 10 секунд: замок не отпущен"), { code: "ENV" });
}

/** Все записи, последняя версия каждой. */
export function all() {
  return [...latestById(FILE()).values()];
}

export function get(id) {
  return latestById(FILE()).get(String(id)) || null;
}

function write(entry, by) {
  return appendJsonl(FILE(), { ...entry, hash: entryHash(entry), contentHash: contentHash(entry), at: new Date().toISOString(), by: by || "система" });
}

/**
 * Поставить или обновить запись. Новая встаёт черновиком. Если у одобренной или ждущей
 * согласования записи изменилось содержимое, она возвращается в черновики: человек
 * клиента говорил «да» другому тексту.
 * @returns {Promise<{ entry: object, result: "создана"|"обновлена"|"без изменений"|"возвращена в черновики" }>}
 */
export async function put(raw, by) {
  const next = normalize(raw);
  const bad = validate(next);
  if (bad.length) throw new RuleError(`запись не принята: ${bad.join("; ")}`);
  return withLock(() => {
    const was = get(next.id);
    if (!was) return { entry: write({ ...next, status: "draft", attempts: 0 }, by), result: "создана" };
    if (was.status === "running") throw new RuleError("запись прямо сейчас выходит, править нельзя");
    if (was.status === "handed") throw new RuleError("пакет с этим текстом уже у сотрудника на ручной выкладке: править нельзя. Снимите запись и заведите новую с другим именем");
    if (isFinal(was.status)) throw new RuleError(`запись уже ${was.status === "published" ? "вышла" : "снята"}: заведите новую с другим именем`);
    if ((was.done?.length ?? 0) > 0) throw new RuleError("часть ветки уже вышла: замена задвоит начало. Хвост дописывается руками");
    const merged = { ...was, ...next, status: was.status, attempts: was.attempts ?? 0, approval: was.approval, done: was.done, result: was.result };
    if (was.contentHash === contentHash(merged)) {
      if (was.hash === entryHash(merged)) return { entry: was, result: "без изменений" };
      return { entry: write(merged, by), result: "обновлена" };
    }
    if (["review", "approved", "failed", "expired"].includes(was.status)) {
      return { entry: write({ ...merged, status: "draft", approval: undefined, note: "текст изменён после согласования" }, by), result: "возвращена в черновики" };
    }
    return { entry: write({ ...merged, status: "draft" }, by), result: "обновлена" };
  });
}

/** Перевести запись в новый статус. patch — что дописать (ссылка, причина, кто одобрил). */
function expectEntry(was,expected={}){
  if(expected.contentHash&&was.contentHash!==expected.contentHash||expected.actionToken&&was.approval?.actionToken!==expected.actionToken||expected.card&&was.approval?.card?.messageId!==expected.card)throw new RuleError('карточка устарела: решение не применено');
}
export async function transition(id, to, patch = {}, by, expected = {}) {
  return withLock(() => {
    const was = get(id);
    if (!was) throw new RuleError(`записи ${id} нет в очереди`);
    expectEntry(was,expected);
    if (!canMove(was.status, to)) throw new RuleError(`переход «${was.status} → ${to}» запрещён`);
    return write({ ...was, ...patch, status: to }, by);
  });
}

/** Дописать поля без смены статуса (номера вышедших реплик, карточка согласования). */
export async function patch(id, fields, by, expected = {}) {
  return withLock(() => {
    const was = get(id);
    if (!was) throw new RuleError(`записи ${id} нет в очереди`);
    expectEntry(was,expected);
    return write({ ...was, ...fields, status: was.status }, by);
  });
}

/**
 * Отметить запись вышедшей в обход таблицы переходов. Единственный законный случай:
 * запись уже вышла НЕ через этот сервер (расписание перехватывал компьютер оператора
 * либо материал выложили руками), и серверу нужно об этом узнать, чтобы не выпустить
 * её второй раз. Черновик и снятую запись так отметить нельзя.
 */
export async function forcePublished(id, fields = {}, by) {
  return withLock(() => {
    const was = get(id);
    if (!was) throw new RuleError(`записи ${id} нет в очереди`);
    if (was.status === "published") return was;
    if (!["approved", "running", "handed", "expired", "failed"].includes(was.status)) throw new RuleError(`запись в статусе «${was.status}»: вышедшей отмечается только одобренная`);
    return write({ ...was, ...fields, status: "published" }, by);
  });
}

/**
 * Отметить, что пакет на ручную выкладку уже ушёл человеку НЕ через этот сервер
 * (расписание вёл компьютер оператора). Иначе после возврата сервер отправит его второй раз.
 */
export async function forceHanded(id, fields = {}, by) {
  return withLock(() => {
    const was = get(id);
    if (!was) throw new RuleError(`записи ${id} нет в очереди`);
    if (was.status === "handed" || was.status === "published") return was;
    if (!["approved", "running", "expired", "failed"].includes(was.status)) throw new RuleError(`запись в статусе «${was.status}»: переданной отмечается только одобренная`);
    return write({ ...was, ...fields, status: "handed" }, by);
  });
}

/**
 * Придержать одобренную запись до взгляда человека. Нужна перехвату расписания: по ответу
 * сервера видно, что он запись начал и не закончил, и выпускать её с компьютера вслепую
 * нельзя. В обход таблицы переходов, как и две функции выше: обычный выпуск приходит к
 * «ошибке» только через «выходит».
 */
export async function forceHeld(id, fields = {}, by) {
  return withLock(() => {
    const was = get(id);
    if (!was) throw new RuleError(`записи ${id} нет в очереди`);
    if (was.status !== "approved") throw new RuleError(`запись в статусе «${was.status}»: придерживается только одобренная`);
    return write({ ...was, ...fields, status: "failed" }, by);
  });
}

/** Переставить слот. Содержимое не меняется, поэтому согласование сохраняется. */
export async function reschedule(id, date, time, by, expected = {}) {
  return withLock(() => {
    const was = get(id);
    if (!was) throw new RuleError(`записи ${id} нет в очереди`);
    expectEntry(was,expected);
    if (["running", "handed"].includes(was.status) || isFinal(was.status)) throw new RuleError(`запись в статусе «${was.status}», слот не переставляется`);
    const next = { ...was, date, time };
    const bad = validate(normalize(next)).filter((b) => b.startsWith("дата"));
    if (bad.length) throw new RuleError(bad.join("; "));
    // Просроченная и упавшая после перестановки снова ждут своего слота.
    const status = ["expired", "failed"].includes(was.status) && was.approval ? "approved" : was.status;
    /* Упавшую либо придержанную перехватом запись человек посмотрел и вернул в расписание.
       Отметка «придержана» снимается, а решение человека запоминается (humanMoved): сверка
       с сервером при перехвате такую запись заново не придерживает, иначе команда
       «переставить» молча отменялась бы на следующем проходе. */
    return write({ ...next, status, attempts: status === "approved" && was.status !== "approved" ? 0 : was.attempts, ...(status !== was.status ? { takeoverHold: undefined, humanMoved: true } : {}) }, by);
  });
}

/**
 * Привести запись к тому, что о ней знает копия расписания: «вышла», «передана» либо
 * «снята». Нужна сверке после восстановления сервера из архива: в архиве запись ещё
 * одобрена либо ждёт «да», а на самом деле она вышла или снята до аварии. В обход таблицы
 * переходов и только в сторону закрытия: выпустить что-либо эта функция не может.
 */
export async function forceFromCopy(id, to, fields = {}, by) {
  if (!["published", "handed", "cancelled"].includes(to)) throw new RuleError(`по копии запись закрывается, а не переводится в «${to}»`);
  return withLock(() => {
    const was = get(id);
    if (!was) throw new RuleError(`записи ${id} нет в очереди`);
    if (isFinal(was.status) || was.status === to) return was;
    return write({ ...was, ...fields, status: to }, by);
  });
}

/**
 * Раз в сутки журнал сжимается: по одной строке на запись, завершённое старше двух
 * месяцев уходит в архив. Зовёт только выпуск, под тем же замком.
 */
export async function compact(now = Date.now(), keepMs = 60 * 86_400_000) {
  return withLock(() => {
    if (!existsSync(FILE())) return 0;
    const rows = all();
    const keep = rows.filter((e) => !(isFinal(e.status) && now - Date.parse(e.at) > keepMs));
    const archive = rows.filter((e) => !keep.includes(e));
    for (const e of archive) appendJsonl(dataPath("queue-archive.jsonl"), e);
    writeAtomic(FILE(), keep.map((e) => JSON.stringify(e)).join("\n") + (keep.length ? "\n" : ""));
    return keep.length;
  });
}

/** Полная история записи: все строки журнала с этим номером. */
export function history(id) {
  return readJsonl(FILE()).filter((e) => String(e.id) === String(id));
}
