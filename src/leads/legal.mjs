// Заслон: бот для людей, формы заявок и кодовые слова работают только с утверждёнными
// текстами согласий.
//
// ЗАЧЕМ ЭТО В КОДЕ, А НЕ В ПАМЯТКЕ. Бот поднимается в первый же день: без него не работает
// рабочая группа, согласование и тревоги. Но тот же бот принимает заявки, а форма /z/
// открыта всему интернету с минуты, когда поднят сервер. Пока юрист клиента не утвердил
// тексты согласий, каждая принятая заявка собрана по документу, которого компания не
// подписывала. Правило «не включать до утверждения», записанное только в документе,
// нарушается первой же случайной ссылкой.
//
// КАК ОТКРЫВАЕТСЯ. Юрист клиента письменно утверждает три документа из legal/site/.
// В legal/site/approved.json у каждого заполняются поля by (кто) и date (когда). Файл
// коммитится и выкладывается на сервер: так в истории остаётся, кто и когда открыл приём.
// Переменной окружения «включить» нет намеренно: её ставят «на минуту, проверить».
//
// ЧТО ЗАКРЫТО ДО УТВЕРЖДЕНИЯ: ответы бота людям (кроме команды /stop: отозвать согласие
// можно всегда), формы заявок, ответы на кодовые слова Instagram. Ничего о человеке при
// этом не записывается. Рабочая группа, согласование, выпуск и отчёты работают.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../lib/env.mjs";
import { readJson } from "../lib/files.mjs";

export const LEGAL_DOCS = ["soglasie", "politika", "soglasie-na-rassylku"];

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
  return gaps;
}

/** Можно ли принимать персональные данные. Ответ держится минуту: файлы читаются редко. */
export function legalReady(now = Date.now()) {
  if (forced !== null) return forced;
  if (now - cache.at > 60_000) cache = { at: now, gaps: legalGaps() };
  return cache.gaps.length === 0;
}

/** Для тестов: открыть или закрыть заслон; null возвращает чтение файлов. */
export function _setLegalReady(value) {
  forced = value;
  cache = { at: 0, gaps: [] };
}
