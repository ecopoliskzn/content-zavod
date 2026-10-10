// Снимок состояния завода для компьютера оператора: один ответ, из которого собираются
// дубль расписания, сырьё для сессий Codex и витрина Obsidian.
//
// ГРАНИЦА ПЕРСОНАЛЬНЫХ ДАННЫХ ПРОХОДИТ ЗДЕСЬ. Сервер в России хранит заявки, подписчиков
// бота и переписку. В снимок из них попадает только счёт: сколько, с какой площадки, что
// просили, взяли ли в работу. Имён, телефонов, номеров аккаунтов и текста заявок в
// снимке нет. Вопросы людей из бота идут обезличенными: без автора, с вычищенными
// телефонами, почтой и именами аккаунтов. Любое новое поле в снимке проверяется этим
// правилом до того, как попасть в код.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { dataPath } from "../lib/env.mjs";
import { readJson, readJsonl } from "../lib/files.mjs";
import { mskDate } from "../lib/time.mjs";
import { latest } from "../metrics/summary.mjs";
import { table as tokenTable } from "../tokens/check.mjs";
import { rows as ledgerRows } from "./ledger.mjs";
import { all } from "./store.mjs";

/** Вычищает из текста то, по чему можно узнать человека. Чистая функция. */
export function mask(text) {
  return String(text || "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[почта]")
    .replace(/(?:\+7|(?<!\d)[78])[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/g, "[телефон]")
    .replace(/(?<!\d)\d[\d\s()-]{8,}\d(?!\d)/g, "[номер]")
    .replace(/@[A-Za-z0-9_.]{3,}/g, "[аккаунт]")
    .replace(/https?:\/\/(?:t\.me|vk\.com|instagram\.com|wa\.me)\/\S+/gi, "[ссылка на профиль]")
    .trim();
}

const count = (rows, key) => rows.reduce((acc, r) => { const k = key(r) || "не определено"; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
const since = (rows, ms, field = "at") => rows.filter((r) => Date.parse(r[field]) >= ms);

/** Воронка без персональных данных. Все входы — строки журналов, выход — только счёт. */
export function funnel({ clicks = [], leads = [], leadCards = [], subscribers = [], igSent = [], now = Date.now(), days = 60 }) {
  const from = now - days * 86_400_000;
  const humanClicks = since(clicks, from).filter((r) => r.device !== "robot");
  const freshLeads = since(leads, from, "createdAt");
  const state = new Map();
  for (const c of leadCards) state.set(c.leadId, { ...(state.get(c.leadId) || {}), ...c });
  const status = (l) => state.get(l.id)?.status || "new";
  // Метка входа без личного хвоста: «ig-priemka-178414…» → «ig-priemka».
  const entryTag = (s) => ((s.tags || []).filter((t) => t.startsWith("вход-")).pop() || "вход-direct").replace("вход-", "").replace(/-\d{10,}$/, "");
  const subs = subscribers.filter((s) => Date.parse(s.subscribedAt || s.updatedAt || 0) >= from);
  return {
    days,
    clicks: { total: humanClicks.length, byDay: count(humanClicks, (r) => mskDate(Date.parse(r.at))), byChannel: count(humanClicks, (r) => r.c), bySlug: count(humanClicks, (r) => r.slug), byPost: count(humanClicks.filter((r) => r.p), (r) => r.p) },
    bot: {
      entered: subs.length,
      byOrigin: count(subs, (s) => s.entryOrigin),
      byEntry: count(subs, entryTag),
      gotMaterial: subs.filter((s) => s.funnel?.material).length,
      startedLead: subs.filter((s) => s.funnel?.leadStart).length,
      leftLead: subs.filter((s) => s.funnel?.lead).length,
      stopped: subs.filter((s) => s.status === "stopped").length,
      adsConsent: subs.filter((s) => s.adsConsent === true).length,
    },
    leads: {
      total: freshLeads.length,
      byDay: count(freshLeads, (l) => mskDate(Date.parse(l.createdAt))),
      bySource: count(freshLeads, (l) => String(l.source || "").split(":").pop()),
      byNeed: count(freshLeads, (l) => l.needTitle || l.need),
      byMaterial: count(freshLeads.filter((l) => l.material), (l) => l.material),
      byStatus: count(freshLeads, status),
    },
    keywords: { byScenario: count(since(igSent, from).filter((r) => r.scenario && !r.failed), (r) => r.scenario), byDay: count(since(igSent, from).filter((r) => r.scenario && !r.failed), (r) => mskDate(Date.parse(r.at))), failed: since(igSent, from).filter((r) => r.failed).length },
  };
}

/** Вопросы людей из бота: обезличенные, без автора. Материал для банка тем. */
export function questions(events, limit = 100) {
  const out = [];
  for (const row of events) {
    const e = row.event || {};
    const text = String(e.text || "");
    if (e.kind !== "message" || !text || text.startsWith("/") || text.length < 12) continue;
    if (/^(?:ig|vk|th|yt|rt|dz|tg|site)-[\w-]+$/i.test(text)) continue; // это метка входа, а не вопрос
    out.push({ day: String(row.at || "").slice(0, 10), text: mask(text).slice(0, 300) });
  }
  return out.slice(-limit);
}

function weeklyReports(limit = 8) {
  const dir = dataPath("reports", "weekly");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort().slice(-limit).map((f) => ({ week: f.replace(/\.md$/, ""), md: readFileSync(path.join(dir, f), "utf8"), json: readJson(path.join(dir, f.replace(/\.md$/, ".json")), null) }));
}

export function snapshot(now = Date.now()) {
  const metricRows = readJsonl(dataPath("metrics.jsonl"));
  const alerts = readJson(dataPath("alerts.json"), {}) || {};
  return {
    at: new Date(now).toISOString(),
    queue: all().sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)),
    ledger: ledgerRows().slice(-2000),
    heartbeat: readJson(dataPath("heartbeat.json"), {}) || {},
    stopped: existsSync(dataPath("STOP")),
    held: existsSync(dataPath("HOLD")),
    metrics: [...latest(metricRows).values()],
    // Ряд замеров за две недели: по нему видно, как пост набирал просмотры.
    metricSeries: since(metricRows, now - 14 * 86_400_000).filter((r) => !r.error).map((r) => ({ id: r.id, day: r.day, views: r.views ?? null })),
    followers: readJsonl(dataPath("followers.jsonl")).slice(-600),
    news: readJsonl(dataPath("news", "inbox.jsonl")).slice(-1500),
    newsHealth: readJson(dataPath("news", "health.json"), {}) || {},
    trends: readJsonl(dataPath("trends", "outliers.jsonl")).slice(-400),
    funnel: funnel({
      clicks: readJsonl(dataPath("go-clicks.jsonl")),
      leads: readJsonl(dataPath("leads", "leads.jsonl")),
      leadCards: readJsonl(dataPath("leads", "lead-cards.jsonl")),
      subscribers: [...new Map(readJsonl(dataPath("leads", "tg-subscribers.jsonl")).map((s) => [s.id, s])).values()],
      igSent: readJsonl(dataPath("leads", "ig-sent.jsonl")),
      now,
    }),
    questions: questions(readJsonl(dataPath("leads", "tg-events.jsonl")).slice(-3000)),
    reports: weeklyReports(),
    tokens: tokenTable(now).map((t) => ({ name: t.name, set: t.set, daysLeft: t.daysLeft, status: t.status })),
    alerts: Object.entries(alerts).map(([key, at]) => ({ key, at: new Date(at).toISOString() })),
  };
}
