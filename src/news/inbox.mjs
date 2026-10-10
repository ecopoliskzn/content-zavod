// Ящик новостей: всё, что нашёл сборщик и что прошло порог по словарю ниши.
//
// Жизнь записи: new → sent (показана в группе) → taken (человек нажал «В работу») или
// skipped («Мимо») → used (сессия сделала из неё материал). Журнал только дописывается.
//
// Новость — сырьё, а не публикация. В очередь выпуска она попадает только текстом,
// который написала сессия, проверили проверки и одобрил человек клиента.

import { dataPath } from "../lib/env.mjs";
import { appendJsonl, latestById } from "../lib/files.mjs";

const FILE = () => dataPath("news", "inbox.jsonl");

export const items = () => [...latestById(FILE()).values()];
export const byStatus = (status) => items().filter((i) => i.status === status);
export const known = (id) => latestById(FILE()).has(String(id));

export function add(item) {
  return appendJsonl(FILE(), { ...item, status: "new", at: new Date().toISOString() });
}

/** Сменить статус. Возвращает false, если записи нет. */
export function setStatus(id, status, by = "") {
  const was = latestById(FILE()).get(String(id));
  if (!was) return false;
  appendJsonl(FILE(), { ...was, status, by, at: new Date().toISOString() });
  return true;
}
