// Заслон: бот для людей, формы заявок и кодовые слова работают только с утверждёнными
// текстами согласий и поданными уведомлениями в Роскомнадзор.
//
// ЗАЧЕМ ЭТО В КОДЕ, А НЕ В ПАМЯТКЕ. Бот поднимается в первый же день: без него не работает
// рабочая группа, согласование и тревоги. Но тот же бот принимает заявки, а форма /z/
// открыта всему интернету с минуты, когда поднят сервер. Пока юрист клиента не утвердил
// тексты согласий, каждая принятая заявка собрана по документу, которого компания не
// подписывала. Правило «не включать до утверждения», записанное только в документе,
// нарушается первой же случайной ссылкой.
//
// КАК ОТКРЫВАЕТСЯ. Четыре записи в legal/site/approved.json, у каждой поля by (кто) и
// date (когда):
//   soglasie, politika, soglasie-na-rassylku — юрист клиента письменно утвердил документ;
//   uvedomlenie-rkn — клиент письменно закрыл вопрос с Роскомнадзором: уведомления об
//                     обработке данных и о передаче за границу поданы либо его юрист
//                     решил, что какое-то из них не требуется (legal/07-УВЕДОМЛЕНИЕ-РКН.md).
//                     Что именно решено, пишется в поле note.
// Файл коммитится и выкладывается на сервер: так в истории остаётся, кто и когда открыл
// приём. Переменной окружения «включить» нет намеренно: её ставят «на минуту, проверить».
//
// ЧТО ЗАКРЫТО ДО ЭТОГО: ответы бота людям (кроме команды /stop: отозвать согласие можно
// всегда), формы заявок, ответы на кодовые слова Instagram. Бот и формы при этом ничего
// о человеке не записывают. Проверка готовности не выпускает публикацию, которая зовёт в
// бота, на форму либо просит написать кодовое слово (src/gates/rules.mjs).
// Рабочая группа, согласование, выпуск и отчёты работают.
//
// ЧЕГО ЗАСЛОН НЕ КАСАЕТСЯ. Счётчик переходов /go считает клики всегда: он пишет обезличенный
// след с суточной солью, по которому не восстановить ни адрес, ни человека (src/leads/go.mjs).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../lib/env.mjs";
import { readJson } from "../lib/files.mjs";

/** Документы, которые утверждает юрист клиента: файл legal/site/<имя>.md. */
export const LEGAL_DOCS = ["soglasie", "politika", "soglasie-na-rassylku"];

/** Подтверждения без файла: что сделано на стороне клиента. Ключ в approved.json → чего не хватает. */
export const LEGAL_CONFIRMATIONS = {
  "uvedomlenie-rkn": "клиент не закрыл вопрос с Роскомнадзором: уведомления об обработке персональных данных и о передаче за границу поданы либо его юрист письменно решил, что они не требуются (legal/07-УВЕДОМЛЕНИЕ-РКН.md; в legal/site/approved.json запись uvedomlenie-rkn, поля by и date)",
};

let forced = null;
let cache = { at: 0, gaps: [] };

/** Незаполненное место в документе: «[наименование исполнителя, ИНН]». Ссылка [текст](адрес) им не считается. */
export const hole = (text) => String(text || "").match(/\[[^\]\n]{3,80}\](?!\()/)?.[0] || "";

/**
 * Чего не хватает, чтобы принимать персональные данные. Пустой список — можно.
 * @param {string} [root] корень проекта (для тестов)
 */
export function legalGaps(root = PROJECT_ROOT) {
  const dir = path.join(root, "legal", "site");
  const approved = readJson(path.join(dir, "approved.json"), {}) || {};
  const gaps = [];
  for (const doc of LEGAL_DOCS) {
    const file = path.join(dir, `${doc}.md`);
    if (!existsSync(file)) { gaps.push(`нет документа legal/site/${doc}.md`); continue; }
    const empty = hole(readFileSync(file, "utf8"));
    if (empty) gaps.push(`в legal/site/${doc}.md не заполнено «${empty}»`);
    if (!approved[doc]?.date || !approved[doc]?.by) gaps.push(`legal/site/${doc}.md не утверждён юристом клиента (legal/site/approved.json: поля by и date)`);
  }
  for (const [key, gap] of Object.entries(LEGAL_CONFIRMATIONS)) {
    if (!approved[key]?.date || !approved[key]?.by) gaps.push(gap);
  }
  return gaps;
}

/**
 * Можно ли принимать персональные данные. Ответ держится минуту: файлы читаются редко.
 * Минута считается по настоящим часам: выпуск в тестах и при догоне живёт в другом времени.
 */
export function legalReady() {
  if (forced !== null) return forced;
  const now = Date.now();
  if (now - cache.at > 60_000) cache = { at: now, gaps: legalGaps() };
  return cache.gaps.length === 0;
}

/** Для тестов: открыть или закрыть заслон; null возвращает чтение файлов. */
export function _setLegalReady(value) {
  forced = value;
  cache = { at: 0, gaps: [] };
}
