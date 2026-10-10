// Проверки записи очереди: собирает окружение (штампы, прошлые заходы, кодовые слова,
// статус площадки) и зовёт чистые правила из rules.mjs.

import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { PROJECT_ROOT, env } from "../lib/env.mjs";
import { isRestricted } from "../lib/config.mjs";
import { readJson } from "../lib/files.mjs";
import { legalReady } from "../leads/legal.mjs";
import { all } from "../queue/store.mjs";
import { checkAll, opener, partsOf } from "./rules.mjs";

const STAMPS = path.join(PROJECT_ROOT, "src", "gates", "stamps.json");
const SCENARIOS = path.join(PROJECT_ROOT, "bot", "scenarios");
const LINKS = path.join(PROJECT_ROOT, "bot", "links.json");

/** Сценарии бота из bot/scenarios/*.json: слова и признак «включён». */
function scenarios() {
  if (!existsSync(SCENARIOS)) return [];
  const out = [];
  for (const f of readdirSync(SCENARIOS).filter((x) => x.endsWith(".json"))) {
    const s = readJson(path.join(SCENARIOS, f));
    for (const item of Array.isArray(s) ? s : [s]) {
      if (item) out.push({ on: item["включён"] !== false && item.enabled !== false, words: (item["слова"] || item.words || []).map(String) });
    }
  }
  return out;
}

/** Кодовые слова бота, включая выключенные сценарии: в Threads их быть не должно. */
export function codeWords() {
  return [...new Set(scenarios().flatMap((s) => s.words))];
}

/** Слова, на которые бот не ответит: их сценарий выключен, и ни один включённый их не несёт. */
export function deadWords() {
  const all = scenarios();
  const live = new Set(all.filter((s) => s.on).flatMap((s) => s.words));
  return [...new Set(all.filter((s) => !s.on).flatMap((s) => s.words))].filter((w) => !live.has(w));
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
  const links = readJson(LINKS, {}) || {};
  return checkAll(entry, {
    stamps: readJson(STAMPS, { phrases: [] })?.phrases || [],
    recentOpeners: recentOpeners(entry.channel, now),
    codeWords: codeWords(),
    deadWords: deadWords(),
    botUsername: env("TG_BOT_USERNAME"),
    restricted: isRestricted(entry.channel),
    // Слаги коротких ссылок: ссылка на неизвестный слаг молча ведёт на главную сайта.
    links: Object.keys(links),
    linkTargets: Object.fromEntries(Object.entries(links).map(([slug, l]) => [slug, String(l?.url || "")])),
    // Открыт ли приём заявок. Пока нет, запись с кодовым словом, ссылкой в бота или на
    // форму не идёт ни на согласование, ни в выпуск: человек пришёл бы к отказу.
    legal: legalReady(),
  });
}
