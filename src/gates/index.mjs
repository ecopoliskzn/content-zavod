// Проверки записи очереди: собирает окружение (штампы, прошлые заходы, кодовые слова,
// статус площадки) и зовёт чистые правила из rules.mjs.

import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { PROJECT_ROOT } from "../lib/env.mjs";
import { isRestricted } from "../lib/config.mjs";
import { readJson } from "../lib/files.mjs";
import { all } from "../queue/store.mjs";
import { checkAll, opener, partsOf } from "./rules.mjs";

const STAMPS = path.join(PROJECT_ROOT, "src", "gates", "stamps.json");
const SCENARIOS = path.join(PROJECT_ROOT, "bot", "scenarios");
const LINKS = path.join(PROJECT_ROOT, "bot", "links.json");

/** Кодовые слова бота из bot/scenarios/*.json: в Threads их быть не должно. */
export function codeWords() {
  if (!existsSync(SCENARIOS)) return [];
  const words = [];
  for (const f of readdirSync(SCENARIOS).filter((x) => x.endsWith(".json"))) {
    const s = readJson(path.join(SCENARIOS, f));
    for (const item of Array.isArray(s) ? s : [s]) for (const w of item?.["слова"] || item?.words || []) words.push(String(w));
  }
  return [...new Set(words)];
}

/** Начала текстов той же площадки за последние 60 дней: одинаковый заход не выходит дважды. */
export function recentOpeners(channel, now = Date.now()) {
  const since = now - 60 * 86_400_000;
  return all()
    .filter((e) => e.channel === channel && e.status !== "cancelled" && Date.parse(e.at) >= since)
    .map((e) => ({ name: e.name, opener: opener(partsOf(e)[0] || "") }));
}

/**
 * Вердикт по записи: { block: string[], warn: string[] }.
 * block — запись не идёт дальше. warn — показывается человеку в карточке согласования.
 */
export function check(entry, now = Date.now()) {
  return checkAll(entry, {
    stamps: readJson(STAMPS, { phrases: [] })?.phrases || [],
    recentOpeners: recentOpeners(entry.channel, now),
    codeWords: codeWords(),
    restricted: isRestricted(entry.channel),
    // Слаги коротких ссылок: ссылка на неизвестный слаг молча ведёт на главную сайта.
    links: Object.keys(readJson(LINKS, {}) || {}),
  });
}
