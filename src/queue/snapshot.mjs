// Снимок состояния завода для компьютера оператора: один ответ, из которого собираются
// дубль расписания, сырьё для сессий Codex и витрина Obsidian.
//
// ГРАНИЦА ПЕРСОНАЛЬНЫХ ДАННЫХ ПРОХОДИТ ЗДЕСЬ. Сервер в России хранит заявки, подписчиков
// бота и переписку. В снимок из них попадает только счёт: сколько, с какой площадки, что
// просили, взяли ли в работу. Имён, телефонов, номеров аккаунтов и текста заявок в
// снимке нет. Любое новое поле в снимке проверяется этим правилом до того, как попасть
// в код, и вопросом: что в это поле может написать сам человек.
//
// НА ТОЙ СТОРОНЕ ТЕКСТ ЧИТАЮТ ПРОГРАММЫ. Снимок приходит на компьютер оператора, где
// работают сессии с искусственным интеллектом на серверах за границей. Поэтому:
//  · вопросы людей из бота по умолчанию не уезжают вовсе, только их число. Чистка по
//    шаблонам убирает телефон и почту, но не имя и не адрес, написанные словами;
//  · публичные комментарии уезжают без автора и с той же чисткой;
//  · номера Telegram сотрудников клиента из записей очереди убираются.
// Первые два пункта переключает клиент: zavod.config.json, блок privacy.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../lib/config.mjs";
import { PROJECT_ROOT, dataPath } from "../lib/env.mjs";
import { readJson, readJsonl } from "../lib/files.mjs";
import { mskDate } from "../lib/time.mjs";
import { latest } from "../metrics/summary.mjs";
import { table as tokenTable } from "../tokens/check.mjs";
import { rows as ledgerRows } from "./ledger.mjs";
import { all } from "./store.mjs";
import { isRestored, stopState } from "./switch.mjs";

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

/**
 * Ключ счёта в снимке. Счёт ведётся по меткам, а метку человек может набрать сам: хвост
 * ссылки, текст после /start. Всё, что на метку не похоже (длинное число, почта, фраза),
 * сворачивается в «прочее»: иначе телефон, набранный после /start, уехал бы с сервера
 * под видом названия строки в таблице.
 */
export const safeKey = (k) => { const s = String(k ?? ""); return /^[\p{L}\d _.:/-]{1,48}$/u.test(s) && !/\d{9,}/.test(s) ? s : "прочее"; };
const count = (rows, key) => rows.reduce((acc, r) => { const k = safeKey(key(r) || "не определено"); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
const since = (rows, ms, field = "at") => rows.filter((r) => Date.parse(r[field]) >= ms);

const ENTRY_MARKS = ["ig", "vk", "th", "yt", "rt", "dz", "tg", "site"];
const ENTRY_WORDS = ["direct", "calendar", "subscribe", "diag"];

/**
 * Метка входа в бота для счёта: «ig-priemka-178414…» → «ig-priemka». Чистая функция.
 * После /start человек может набрать что угодно, и бот запомнит это как метку. В счёт
 * идут только метки завода: площадка и ключ материала. Остальное — «прочее».
 * @param {string[]} [known] ключи материалов и сценариев; пусто — ключ не сверяется
 */
export function entryLabel(tag, known = []) {
  const raw = String(tag || "direct").replace(/^вход-/, "").replace(/-\d{10,}$/, "").toLowerCase();
  if (ENTRY_WORDS.includes(raw)) return raw;
  const m = raw.match(/^([a-z]{2,4})-([a-z0-9-]{1,40})$/);
  if (m && ENTRY_MARKS.includes(m[1])) return known.length && !known.includes(m[2].replace(/--[a-z]+$/, "")) ? `${m[1]}-прочее` : raw;
  return known.includes(raw) ? raw : "прочее";
}

/** Воронка без персональных данных. Все входы — строки журналов, выход — только счёт. */
export function funnel({ clicks = [], leads = [], leadCards = [], subscribers = [], igSent = [], now = Date.now(), days = 60, knownEntries = [] }) {
  const from = now - days * 86_400_000;
  const humanClicks = since(clicks, from).filter((r) => r.device !== "robot");
  const freshLeads = since(leads, from, "createdAt");
  const state = new Map();
  for (const c of leadCards) state.set(c.leadId, { ...(state.get(c.leadId) || {}), ...c });
  const status = (l) => state.get(l.id)?.status || "new";
  const entryTag = (s) => entryLabel((s.tags || []).filter((t) => t.startsWith("вход-")).pop(), knownEntries);
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

/** Сколько вопросов задали в боте: один счёт, без текста. Чистая функция. */
export function questionCount(events, now = Date.now(), days = 60) {
  const from = now - days * 86_400_000;
  const byDay = {};
  let total = 0;
  for (const row of events) {
    const e = row.event || {};
    const text = String(e.text || "");
    if (e.kind !== "message" || !text || text.startsWith("/") || text.length < 12 || !(Date.parse(row.at) >= from)) continue;
    if (/^(?:ig|vk|th|yt|rt|dz|tg|site)-[\w-]+$/i.test(text)) continue;
    const day = String(row.at).slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
    total++;
  }
  return { days, total, byDay };
}

/**
 * Запись очереди для снимка: без номеров Telegram. Имя утверждающего остаётся: это
 * запись о том, кто от имени компании сказал «да», и ради неё согласование и ведётся.
 */
export function publicEntry(entry) {
  const out = { ...entry };
  // Номер Telegram лежит в двух местах: у согласия и у просьбы о правке.
  for (const field of ["approval", "fixAsked"]) {
    if (out[field] && typeof out[field] === "object") { const { by, ...rest } = out[field]; out[field] = rest; }
  }
  if (/^tg:\d+$/.test(String(out.by || ""))) out.by = "рабочая группа";
  return out;
}

/**
 * Комментарии под публикациями для снимка. Автора сборщик не хранит, но человек мог сам
 * написать в комментарии телефон или почту: текст проходит ту же чистку, что и вопросы.
 * Полный текст остаётся на сервере и в карточке рабочей группы, где его видит сотрудник.
 */
export function publicComments(rows, limit = 400) {
  const last = new Map();
  for (const c of rows) if (c && c.id) last.set(c.id, c);
  return [...last.values()].slice(-limit).map((c) => ({ id: c.id, platform: c.platform, at: c.at, status: c.status, link: c.link, post: c.post, text: mask(c.text).slice(0, 600) }));
}

function weeklyReports(limit = 8) {
  const dir = dataPath("reports", "weekly");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort().slice(-limit).map((f) => ({ week: f.replace(/\.md$/, ""), md: readFileSync(path.join(dir, f), "utf8"), json: readJson(path.join(dir, f.replace(/\.md$/, ".json")), null) }));
}

/** Ключи материалов и сценариев бота: только они считаются метками входа. */
function entryKeys() {
  const keys = new Set();
  for (const m of readJson(path.join(PROJECT_ROOT, "bot", "materials.json"), []) || []) if (m?.key) keys.add(String(m.key).toLowerCase());
  const dir = path.join(PROJECT_ROOT, "bot", "scenarios");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const s = readJson(path.join(dir, f), {}) || {};
      for (const item of Array.isArray(s) ? s : [s]) { const key = item?.["ключ"] || item?.key; if (key) keys.add(String(key).toLowerCase()); }
    }
  }
  return [...keys];
}

export function snapshot(now = Date.now()) {
  const metricRows = readJsonl(dataPath("metrics.jsonl"));
  const alerts = readJson(dataPath("alerts.json"), {}) || {};
  // Что из написанного людьми уезжает с сервера, решает клиент: zavod.config.json, блок
  // privacy. На компьютере оператора эти тексты читают программы на основе искусственного
  // интеллекта, поэтому по умолчанию вопросы из бота не уезжают вовсе: только их число.
  const privacy = config().privacy || {};
  const botEvents = readJsonl(dataPath("leads", "tg-events.jsonl"));
  const commentRows = publicComments(readJsonl(dataPath("comments.jsonl")), 100_000);
  const youtubeHistory = readJson(dataPath('youtube', 'latest.json'), null);
  if (youtubeHistory?.latest?.taken) youtubeHistory.staleDays = Number(((now - Date.parse(youtubeHistory.latest.taken)) / 86400000).toFixed(2));
  return {
    at: new Date(now).toISOString(),
    queue: all().sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)).map(publicEntry),
    ledger: ledgerRows().slice(-2000),
    heartbeat: readJson(dataPath("heartbeat.json"), {}) || {},
    stopped: stopState().stopped,
    // Кто остановил: человек либо перехват. По этому компьютер оператора решает, можно ли перехватывать.
    stop: { human: stopState().human, takeover: stopState().takeover },
    held: existsSync(dataPath("HOLD")),
    // Каталог данных развёрнут из архива: копию на компьютере оператора таким снимком затирать нельзя.
    restored: isRestored(),
    metrics: [...latest(metricRows).values()],
    // Ряд замеров за две недели: по нему видно, как пост набирал просмотры.
    metricSeries: since(metricRows, now - 14 * 86_400_000).filter((r) => !r.error).map((r) => ({ id: r.id, day: r.day, views: r.views ?? null })),
    followers: readJsonl(dataPath("followers.jsonl")).slice(-600),
    // Только сведения и цифры собственного канала, без описаний и комментариев людей.
    youtubeHistory,
    commentsHealth: readJson(dataPath('comments-health.json'), null),
    news: readJsonl(dataPath("news", "inbox.jsonl")).slice(-1500),
    newsHealth: readJson(dataPath("news", "health.json"), {}) || {},
    trends: readJsonl(dataPath("trends", "outliers.jsonl")).slice(-400),
    trendsDaily: readJson(dataPath("trends", "sites", "latest.json"), null),
    funnel: funnel({
      clicks: readJsonl(dataPath("go-clicks.jsonl")),
      leads: readJsonl(dataPath("leads", "leads.jsonl")),
      leadCards: readJsonl(dataPath("leads", "lead-cards.jsonl")),
      subscribers: [...new Map(readJsonl(dataPath("leads", "tg-subscribers.jsonl")).map((s) => [s.id, s])).values()],
      igSent: readJsonl(dataPath("leads", "ig-sent.jsonl")),
      now,
      knownEntries: entryKeys(),
    }),
    questions: privacy.shareBotQuestions === true ? questions(botEvents.slice(-3000)) : [],
    questionCount: questionCount(botEvents, now),
    // Комментарии под публикациями: текст, площадка, ссылка. Авторов сборщик не хранит вовсе.
    comments: privacy.shareComments === false ? [] : commentRows.slice(-400),
    commentCount: { total: commentRows.length, open: commentRows.filter((c) => c.status === "new").length },
    reports: weeklyReports(),
    tokens: tokenTable(now).map((t) => ({ name: t.name, set: t.set, daysLeft: t.daysLeft, status: t.status })),
    alerts: Object.entries(alerts).map(([key, at]) => ({ key, at: new Date(at).toISOString() })),
  };
}
