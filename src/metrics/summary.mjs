// Сводка цифр: чистые функции. Журналы на вход, готовая картина недели на выход.
//
// ЧТО СЧИТАЕМ И ЗАЧЕМ. Завод существует ради заявок, поэтому сверху всегда они: сколько
// и с какой площадки. Просмотры идут ниже и нужны, чтобы понять, что повторять.
//
// СРАВНИВАЕМ ПОСТ С ЕГО ПЛОЩАДКОЙ, А НЕ ПЛОЩАДКИ МЕЖДУ СОБОЙ. Тысяча просмотров в Threads
// и тысяча в Telegram-канале на четыреста человек — разные события. Каждый пост делится
// на медиану своей площадки: «в 3,2 раза выше обычного» сравнимо везде.
//
// МЕДИАНА, А НЕ СРЕДНЕЕ. Один залетевший пост утягивает среднее так, что все остальные
// выглядят провалом. Медиана показывает обычный день.

import { mskDate, weekStart } from "../lib/time.mjs";

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

/** Последний удачный замер каждой публикации. */
export function latest(metricRows) {
  const map = new Map();
  for (const r of metricRows) if (r && r.id && !r.error) map.set(r.id, { ...(map.get(r.id) || {}), ...r });
  return map;
}

/** Прошлая полная неделя (пн 00:00 – вс 24:00 по Москве) относительно момента. */
export function lastWeek(now = Date.now()) {
  const thisMonday = Date.parse(`${weekStart(now)}T00:00:00+03:00`);
  return { from: thisMonday - 7 * 86_400_000, to: thisMonday, label: mskDate(thisMonday - 7 * 86_400_000) };
}

const inWindow = (iso, w) => { const t = Date.parse(iso); return t >= w.from && t < w.to; };
const channelOfSource = (source) => String(source || "").split(":").pop() || "не определён";

/**
 * @param {{
 *   ledger: Array<object>, metrics: Array<object>, followers?: Array<object>,
 *   clicks?: Array<object>, leads?: Array<object>, leadCards?: Array<object>, keywords?: Array<object>,
 *   window: { from: number, to: number, label: string }, channelTitles?: Record<string,string>,
 *   activeChannels?: string[]
 * }} input
 */
export function summarize({ ledger, metrics, followers = [], clicks = [], leads = [], leadCards = [], keywords = [], window, channelTitles = {}, activeChannels = [] }) {
  const title = (c) => channelTitles[c] || c;
  const numbers = latest(metrics);

  // Вышедшее за неделю: по одной строке на запись (повторная запись в журнале не удваивает).
  const published = new Map();
  for (const r of ledger) if (r.status === "published" && inWindow(r.at, window)) published.set(r.id, r);
  const posts = [...published.values()].map((r) => ({ ...r, ...(numbers.get(r.id) || {}), id: r.id, channel: r.channel, name: r.name, material: r.material, slot: r.slot, link: r.link || "" }));

  // История площадки: медиана по всему, что мерили за последние восемь недель.
  const history = new Map();
  for (const r of ledger) {
    if (r.status !== "published" || Date.parse(r.at) < window.to - 56 * 86_400_000 || Date.parse(r.at) >= window.to) continue;
    const n = numbers.get(r.id);
    if (n?.views === undefined) continue;
    if (!history.has(r.channel)) history.set(r.channel, new Map());
    history.get(r.channel).set(r.id, n.views);
  }
  const usual = (channel) => median([...(history.get(channel)?.values() || [])]);

  const channels = {};
  // Подключённые площадки заводим заранее: площадка без единого выхода за неделю должна
  // быть видна в отчёте нулём, а не пропасть из него.
  for (const c of activeChannels) channels[c] = { channel: c, title: title(c), posts: 0, measured: 0, views: 0, list: [] };
  for (const p of posts) {
    const c = (channels[p.channel] ||= { channel: p.channel, title: title(p.channel), posts: 0, measured: 0, views: 0, list: [] });
    c.posts++;
    c.list.push(p);
    if (Number.isFinite(p.views)) { c.measured++; c.views += p.views; }
  }
  for (const c of Object.values(channels)) {
    c.median = median(c.list.map((p) => p.views));
    c.usual = usual(c.channel);
    const measured = c.list.filter((p) => Number.isFinite(p.views)).sort((a, b) => b.views - a.views);
    c.best = measured[0] || null;
    c.worst = measured.length > 1 ? measured[measured.length - 1] : null;
    delete c.list;
  }

  const rated = posts
    .filter((p) => Number.isFinite(p.views))
    .map((p) => ({ ...p, ratio: usual(p.channel) ? p.views / usual(p.channel) : 0 }))
    .sort((a, b) => b.ratio - a.ratio);

  // Один материал на нескольких площадках: что зашло везде, то и повторять.
  const byMaterial = {};
  for (const p of rated) {
    const m = (byMaterial[p.material || "без материала"] ||= { material: p.material || "без материала", channels: [], views: 0, ratios: [] });
    m.channels.push(p.channel);
    m.views += p.views;
    m.ratios.push(p.ratio);
  }
  const materials = Object.values(byMaterial).map((m) => ({ ...m, ratio: m.ratios.reduce((a, b) => a + b, 0) / m.ratios.length })).sort((a, b) => b.ratio - a.ratio);

  // Слоты: медиана по часу выхода, за восемь недель, чтобы на слот набралось хотя бы три поста.
  const slots = {};
  for (const r of ledger) {
    if (r.status !== "published" || Date.parse(r.at) < window.to - 56 * 86_400_000 || Date.parse(r.at) >= window.to) continue;
    const n = numbers.get(r.id);
    const time = String(r.slot || "").split(" ")[1];
    if (n?.views === undefined || !time) continue;
    ((slots[r.channel] ||= {})[time] ||= []).push(n.views);
  }
  const slotTable = Object.fromEntries(Object.entries(slots).map(([c, byTime]) => [c, Object.entries(byTime).map(([time, v]) => ({ time, posts: v.length, median: median(v) })).sort((a, b) => a.time.localeCompare(b.time))]));

  // Ролики YouTube: досмотр и подписки с ролика. Просмотры зависят от раздачи, досмотр от
  // самого ролика, поэтому «что снимать дальше» решают по нему. Обычный досмотр считается
  // по восьми неделям: разница меньше десяти пунктов ничего не доказывает.
  const watchHistory = [];
  for (const r of ledger) {
    if (r.status !== "published" || r.channel !== "youtube" || Date.parse(r.at) < window.to - 56 * 86_400_000 || Date.parse(r.at) >= window.to) continue;
    const n = numbers.get(r.id);
    if (Number.isFinite(n?.watchPct)) watchHistory.push(n.watchPct);
  }
  const usualWatch = median(watchHistory);
  const video = {
    usualWatch,
    list: posts
      .filter((p) => p.channel === "youtube")
      .map((p) => ({ id: p.id, name: p.name, material: p.material, link: p.link, views: p.views ?? null, watchPct: p.watchPct ?? null, avgSec: p.avgSec ?? null, subs: p.subs ?? null }))
      .sort((a, b) => (b.watchPct ?? -1) - (a.watchPct ?? -1)),
  };

  // Переходы на сайт через наш счётчик. Роботы уже отсеяны при записи.
  const clickRows = clicks.filter((r) => r.device !== "robot" && inWindow(r.at, window));
  const clicksByChannel = {};
  for (const r of clickRows) clicksByChannel[r.c || "без метки"] = (clicksByChannel[r.c || "без метки"] || 0) + 1;

  // Заявки: только счёт. Ни имён, ни телефонов в сводку не попадает.
  const leadRows = leads.filter((l) => inWindow(l.createdAt, window));
  const cardState = new Map();
  for (const c of leadCards) cardState.set(c.leadId, { ...(cardState.get(c.leadId) || {}), ...c });
  const leadsBySource = {};
  const leadsByNeed = {};
  let taken = 0;
  let rejected = 0;
  let unanswered = 0;
  for (const l of leadRows) {
    const source = channelOfSource(l.source);
    leadsBySource[source] = (leadsBySource[source] || 0) + 1;
    leadsByNeed[l.needTitle || l.need || "без уточнения"] = (leadsByNeed[l.needTitle || l.need || "без уточнения"] || 0) + 1;
    const st = cardState.get(l.id)?.status;
    if (st === "taken") taken++;
    else if (st === "rejected") rejected++;
    else unanswered++;
  }

  const keywordHits = {};
  for (const k of keywords) if (!k.failed && k.scenario && inWindow(k.at, window)) keywordHits[k.scenario] = (keywordHits[k.scenario] || 0) + 1;

  // Подписчики: разница между первым и последним замером недели.
  const fol = {};
  for (const f of followers) {
    if (!Number.isFinite(f.count) || Date.parse(f.at) < window.from - 86_400_000 || Date.parse(f.at) >= window.to + 86_400_000) continue;
    const c = (fol[f.channel] ||= { first: f, last: f });
    if (Date.parse(f.at) < Date.parse(c.first.at)) c.first = f;
    if (Date.parse(f.at) > Date.parse(c.last.at)) c.last = f;
  }
  const followersDelta = Object.fromEntries(Object.entries(fol).map(([c, v]) => [c, { now: v.last.count, delta: v.last.count - v.first.count }]));

  return {
    week: window.label,
    posts: posts.length,
    measured: rated.length,
    channels,
    top: rated.slice(0, 5),
    bottom: rated.length > 5 ? rated.slice(-3).reverse() : [],
    materials,
    slots: slotTable,
    clicks: { total: clickRows.length, unique: new Set(clickRows.map((r) => r.v)).size, byChannel: clicksByChannel },
    leads: { total: leadRows.length, bySource: leadsBySource, byNeed: leadsByNeed, taken, rejected, unanswered },
    keywords: keywordHits,
    followers: followersDelta,
    video,
    suggestions: suggest({ channels, slotTable, materials, leadsBySource, clicksByChannel, title, video }),
  };
}

/**
 * Предложения на следующую неделю. Не больше трёх, и каждое опирается на цифру.
 * Это подсказка для сессии разбора и для человека, а не решение: решение принимает он.
 */
export function suggest({ channels, slotTable, materials, leadsBySource, clicksByChannel, title, video }) {
  const out = [];
  // Ролик, который досмотрели заметно лучше обычного: повод для продолжения. Порог в десять
  // пунктов: меньшая разница — шум раздачи, а не свойство ролика.
  const held = (video?.list || []).filter((v) => Number.isFinite(v.watchPct) && video.usualWatch && v.watchPct - video.usualWatch >= 10)[0];
  if (held) out.push({ weight: 2 + (held.watchPct - video.usualWatch) / 10, text: `YouTube: ролик «${held.name}» досмотрели на ${Math.round(held.watchPct)}% при обычных ${Math.round(video.usualWatch)}%. Снять продолжение в ту же серию.` });
  for (const [channel, rows] of Object.entries(slotTable)) {
    const enough = rows.filter((r) => r.posts >= 3);
    if (enough.length < 2) continue;
    const best = enough.reduce((a, b) => (b.median > a.median ? b : a));
    const worst = enough.reduce((a, b) => (b.median < a.median ? b : a));
    if (worst.median > 0 && best.median / worst.median >= 1.5) {
      out.push({ weight: best.median / worst.median, text: `${title(channel)}: слот ${best.time} даёт медиану ${best.median}, слот ${worst.time} — ${worst.median}. Перенести один выход из ${worst.time} в ${best.time}.` });
    }
  }
  const strong = materials.filter((m) => m.ratio >= 2 && m.material !== "без материала")[0];
  if (strong) out.push({ weight: strong.ratio, text: `Материал «${strong.material}» вышел в ${strong.ratio.toFixed(1).replace(".", ",")} раза выше обычного (${[...new Set(strong.channels)].map(title).join(", ")}). Сделать по нему продолжение: вторую ветку и ролик.` });
  const silent = Object.values(channels).filter((c) => c.posts === 0).map((c) => c.title);
  if (silent.length) out.push({ weight: 1.2, text: `Молчали: ${silent.join(", ")}. Пропуск дня режет охват сильнее слабого поста.` });
  const talk = Object.entries(clicksByChannel).sort((a, b) => b[1] - a[1])[0];
  const lead = Object.entries(leadsBySource).sort((a, b) => b[1] - a[1])[0];
  if (lead && lead[1] >= 2) out.push({ weight: 3 + lead[1], text: `Заявки пришли в основном с площадки «${title(lead[0])}»: ${lead[1]}. Поставить туда на один выход больше.` });
  else if (talk && talk[1] >= 10 && !Object.keys(leadsBySource).length) out.push({ weight: 1.5, text: `Переходов на сайт с «${title(String(talk[0]).replace(/^bot-/, ""))}» ${talk[1]}, заявок ноль. Проверить страницу, на которую ведёт ссылка: до формы человек не доходит.` });
  return out.sort((a, b) => b.weight - a.weight).slice(0, 3).map((s) => s.text);
}
