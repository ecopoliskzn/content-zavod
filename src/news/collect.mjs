#!/usr/bin/env node
// Сборщик новостей по теме. Cron на сервере раз в три часа:
//   0 4-19/3 * * * node /opt/ecopolis-zavod/current/src/news/collect.mjs --send
//
// Обходит источники из sources.json (ленты RSS и Atom, витрины Telegram-каналов,
// страницы новостей без ленты), оценивает каждую запись по словарю ниши
// (dictionary.json) и складывает прошедшее порог в ящик. С флагом --send лучшие новости
// уходят в рабочую группу карточками с кнопками «В работу» и «Мимо».
//
// ЧТО СБОРЩИК НЕ ДЕЛАЕТ. Не пишет тексты и ничего не публикует. Он приносит сырьё:
// заголовок, адрес, дату. Что из этого станет веткой или постом, решает человек кнопкой,
// а пишет сессия по образцу prompts/samples/новость-в-заметку.md.
//
// Источник может молчать или отвечать ошибкой: это не поломка сборщика. Источник,
// упавший три прохода подряд, попадает в одну общую тревогу, а не в три отдельных.
//
// Запуск руками:  node src/news/collect.mjs [--send] [--dry] [--source=<id>]

import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PROJECT_ROOT, dataPath } from "../lib/env.mjs";
import { readJson, writeJson } from "../lib/files.mjs";
import { sleep } from "../lib/http.mjs";
import { alert, h, resolve, toGroup } from "../lib/notify.mjs";
import { add, byStatus, known, setStatus } from "./inbox.mjs";
import { canonical, parseFeed, parseLinks, parseTelegram, score } from "./parse.mjs";

const DIR = path.join(PROJECT_ROOT, "src", "news");
const THRESHOLD = 5;
const MAX_AGE_DAYS = 10;
const PER_DIGEST = 5;

const flag = (name) => process.argv.includes(`--${name}`);
const opt = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").split("=")[1] || "";

/** Страница с учётом кодировки: часть ведомственных сайтов до сих пор отдаёт windows-1251. */
export async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; zavod-news/1.0)", accept: "*/*" }, signal: AbortSignal.timeout(25_000), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const head = bytes.subarray(0, 2000).toString("latin1");
  const charset = (res.headers.get("content-type") || "").match(/charset=([\w-]+)/i)?.[1] || head.match(/encoding=["']([\w-]+)["']/i)?.[1] || head.match(/charset=["']?([\w-]+)/i)?.[1] || "utf-8";
  try { return new TextDecoder(charset.toLowerCase()).decode(bytes); } catch { return bytes.toString("utf8"); }
}

async function read(source) {
  const body = await fetchText(source.url);
  if (source.type === "tg") return parseTelegram(body);
  if (source.type === "html") {
    // Без шаблона адреса новости страница отдаёт всё меню сайта: такой источник не читаем.
    if (!source.pattern) throw new Error("у источника вида html не задан pattern");
    return parseLinks(body, source.url, source.pattern);
  }
  return parseFeed(body);
}

/**
 * Проходит ли новость в ящик. Чистая функция: запись, вес источника и словарь на вход.
 * Три условия: сработало хотя бы одно слово ниши; сумма весов с весом источника не ниже
 * порога; среди сработавших правил есть якорь темы. Без якоря «травма» и «Казань» дают
 * новость про футболиста, а не про покрытия.
 * @returns {{ pass: boolean, score: number, tags: string[] }}
 */
export function rate(raw, sourceWeight, dict) {
  const rated = score(raw, dict.rules || []);
  const total = rated.score + (sourceWeight || 0);
  const anchors = Array.isArray(dict.anchors) ? dict.anchors : [];
  const pass = rated.score >= 1 && total >= (Number(dict.threshold) || THRESHOLD) && (!anchors.length || rated.tags.some((t) => anchors.includes(t)));
  return { pass, score: total, tags: rated.tags };
}

export async function collect({ dry = false, only = "" } = {}) {
  const sources = (readJson(path.join(DIR, "sources.json"), { sources: [] })?.sources || []).filter((s) => s.enabled !== false && (!only || s.id === only));
  const dict = readJson(path.join(DIR, "dictionary.json"), { rules: [] }) || { rules: [] };
  const health = readJson(dataPath("news", "health.json"), {}) || {};
  const fresh = [];
  const now = Date.now();

  for (const source of sources) {
    try {
      const found = await read(source);
      health[source.id] = { ok: new Date().toISOString(), fails: 0, last: found.length };
      for (const raw of found) {
        const url = canonical(raw.url);
        const id = createHash("sha1").update(url).digest("hex").slice(0, 16);
        if (known(id)) continue;
        if (raw.published && now - Date.parse(raw.published) > MAX_AGE_DAYS * 86_400_000) continue;
        const rated = rate(raw, source.weight, dict);
        if (!rated.pass) continue;
        const item = { id, source: source.id, sourceTitle: source.title, title: raw.title, url, published: raw.published || "", summary: raw.summary || "", score: rated.score, tags: rated.tags, ...(raw.views ? { views: raw.views } : {}) };
        fresh.push(item);
        if (!dry) add(item);
      }
    } catch (e) {
      const prev = health[source.id] || {};
      health[source.id] = { ...prev, fails: (prev.fails || 0) + 1, error: String(e.message || e).slice(0, 120), failedAt: new Date().toISOString() };
    }
    await sleep(700); // не частим: источников два-три десятка, спешить некуда
  }
  if (!dry) writeJson(dataPath("news", "health.json"), health);
  return { fresh, health, sources: sources.length };
}

/** Лучшие новые новости карточками в группу. Не больше PER_DIGEST за проход. */
export async function sendDigest() {
  const top = byStatus("new").sort((a, b) => b.score - a.score || String(b.published).localeCompare(String(a.published))).slice(0, PER_DIGEST);
  for (const item of top) {
    const text = [`📰 <b>${h(item.title)}</b>`, `${h(item.sourceTitle || item.source)}${item.published ? ` · ${h(item.published.slice(0, 10))}` : ""} · темы: ${h((item.tags || []).join(", ") || "общее")}`, item.summary ? `\n${h(item.summary.slice(0, 350))}` : "", `\n${h(item.url)}`].join("\n");
    const sent = await toGroup("news", text, { buttons: [[{ text: "В работу", data: `n:take:${item.id}` }, { text: "Мимо", data: `n:skip:${item.id}` }]] });
    if (sent.ok) setStatus(item.id, "sent", "сборщик");
    await sleep(1200);
  }
  return top.length;
}

async function main() {
  const { fresh, health, sources } = await collect({ dry: flag("dry"), only: opt("source") });
  console.log(`${new Date().toISOString()} источников ${sources}, новых записей ${fresh.length}`);
  if (flag("dry")) for (const f of fresh.slice(0, 20)) console.log(`  ${String(f.score).padStart(2)}  ${f.source}  ${f.title.slice(0, 90)}`);
  const dead = Object.entries(health).filter(([, v]) => (v.fails || 0) >= 3).map(([id, v]) => `${id}: ${v.error}`);
  if (!flag("dry")) {
    if (dead.length) await alert(`news:dead:${dead.map((d) => d.split(":")[0]).sort().join(",")}`, `Источники новостей молчат три прохода подряд:\n${h(dead.join("\n"))}`, { action: "перешлите это сообщение оператору: адрес ленты мог смениться, его правят в src/news/sources.json" });
    else resolve("news:dead");
    if (flag("send")) console.log(`в группу ушло карточек: ${await sendDigest()}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`сбой сборщика: ${e?.stack || e}`); process.exitCode = 2; });
}
