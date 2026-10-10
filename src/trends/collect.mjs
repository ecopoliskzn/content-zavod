#!/usr/bin/env node
// Слежение за чужими удачами: что у конкурентов и соседей по теме набрало заметно больше
// обычного. Cron на сервере раз в сутки:
//   40 3 * * * node /opt/ecopolis-zavod/current/src/trends/collect.mjs
//
// КАК ИЩЕМ. У каждого канала из списка (src/trends/watchlist.json) берём последние
// публикации и сравниваем каждую с медианой ЭТОГО ЖЕ канала. Ролик на 40 тысяч у канала
// с обычными двумястами тысячами — провал, а на 40 тысяч у канала с обычными тремя — то,
// что стоит разобрать. Абсолютные просмотры между каналами не сравниваются.
//
// ЧТО ДЕЛАЕМ С НАХОДКОЙ. Находка — повод для своей темы, а не текст для пересказа.
// Сессия S4 смотрит, ПОЧЕМУ зашло (вопрос, боль, цифра в зачине), и ставит в банк тем
// свой угол на своём материале. Чужой текст и чужие кадры не копируются.
//
// Источники:
//   YouTube   — открытый ключ API (YOUTUBE_API_KEY): плейлист загрузок канала и статистика.
//               Это 2 единицы квоты на канал; поиск по словам (100 единиц за запрос)
//               включается отдельным флагом --search и не чаще раза в неделю;
//   Telegram  — веб-витрина t.me/s/<канал>, ключ не нужен;
//   ВКонтакте — сервисный ключ приложения (VK_SERVICE_TOKEN), метод wall.get.
//
//   node src/trends/collect.mjs [--youtube] [--rutube] [--telegram] [--vk] [--search] [--dry]
//   node src/trends/collect.mjs --digest      напечатать сводку находок для сессии S4

import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_ROOT, dataPath, env } from "../lib/env.mjs";
import { appendJsonl, readJson, readJsonl } from "../lib/files.mjs";
import { request, sleep } from "../lib/http.mjs";
import { median } from "../metrics/summary.mjs";
import { parseTelegram } from "../news/parse.mjs";
import { parseViews } from "../channels/telegram.mjs";

const flag = (name) => process.argv.includes(`--${name}`);
const WATCHLIST = path.join(PROJECT_ROOT, "src", "trends", "watchlist.json");
const OUT = () => dataPath("trends", "outliers.jsonl");
const YT = "https://www.googleapis.com/youtube/v3";

/**
 * Выбросы среди публикаций одного канала. Чистая функция.
 * База — медиана публикаций старше трёх суток: свежие ещё набирают.
 * @param {Array<{ title: string, url: string, views: number, published: string }>} posts
 */
export function outliers(posts, { now = Date.now(), factor = 3, minViews = 300, maxAgeDays = 120 } = {}) {
  const settled = posts.filter((p) => Number.isFinite(p.views) && now - Date.parse(p.published) > 3 * 86_400_000);
  if (settled.length < 6) return { median: 0, found: [] }; // по пяти постам «обычное» не определить
  const base = median(settled.map((p) => p.views));
  if (!base) return { median: 0, found: [] };
  const found = posts
    .filter((p) => Number.isFinite(p.views) && p.views >= minViews && p.views >= base * factor && now - Date.parse(p.published) <= maxAgeDays * 86_400_000)
    .map((p) => ({ ...p, median: base, ratio: Math.round((p.views / base) * 10) / 10 }))
    .sort((a, b) => b.ratio - a.ratio);
  return { median: base, found };
}

async function youtubeChannel(channelId, key) {
  // Плейлист загрузок канала получается из его номера заменой второй буквы: UC… → UU….
  const uploads = `UU${channelId.slice(2)}`;
  const list = await request(`${YT}/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}&key=${encodeURIComponent(key)}`, { retries: 1 });
  if (list.kind !== "ok") return { error: list.error };
  const ids = (list.data?.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean);
  if (!ids.length) return { posts: [] };
  const stats = await request(`${YT}/videos?part=snippet,statistics,contentDetails&id=${ids.join(",")}&key=${encodeURIComponent(key)}`, { retries: 1 });
  if (stats.kind !== "ok") return { error: stats.error };
  return {
    posts: (stats.data?.items || []).map((v) => ({
      title: v.snippet?.title || "",
      url: `https://www.youtube.com/watch?v=${v.id}`,
      views: Number(v.statistics?.viewCount),
      likes: Number(v.statistics?.likeCount) || 0,
      comments: Number(v.statistics?.commentCount) || 0,
      published: v.snippet?.publishedAt || "",
      duration: v.contentDetails?.duration || "",
    })),
  };
}

/** Лента канала без ключа: последние 15 роликов с просмотрами. Разбор вынесен ради теста. */
export function parseYoutubeFeed(xml) {
  const out = [];
  for (const block of String(xml).split(/<entry[\s>]/i).slice(1)) {
    const id = block.match(/<yt:videoId>([^<]+)</)?.[1];
    if (!id) continue;
    const title = (block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    out.push({ title, url: `https://www.youtube.com/watch?v=${id}`, views: Number(block.match(/<media:statistics[^>]*views="(\d+)"/)?.[1]), published: block.match(/<published>([^<]+)</)?.[1] || "" });
  }
  return out;
}

async function youtubeFeed(channelId) {
  try {
    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, { signal: AbortSignal.timeout(25_000) });
    if (!res.ok) return { error: `лента канала ответила ${res.status}` };
    return { posts: parseYoutubeFeed(await res.text()) };
  } catch (e) {
    // С сервера в России youtube.com может не открываться вовсе: это не поломка сборщика.
    return { error: `лента канала не открылась: ${e?.cause?.code || e?.name || e}` };
  }
}

/** Канал Rutube без ключа: открытый JSON со списком роликов и просмотрами. */
async function rutubeChannel(personId) {
  const r = await request(`https://rutube.ru/api/video/person/${encodeURIComponent(personId)}/?page=1`, { headers: { accept: "application/json" }, retries: 1 });
  if (r.kind !== "ok") return { error: r.error };
  return {
    posts: (r.data?.results || []).map((v) => ({
      title: v.title || "",
      url: v.video_url || `https://rutube.ru/video/${v.id}/`,
      views: Number(v.hits),
      published: v.publication_ts || v.created_ts || "",
    })),
  };
}

async function youtubeSearch(query, key) {
  const after = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const r = await request(`${YT}/search?part=snippet&type=video&order=viewCount&maxResults=15&regionCode=RU&relevanceLanguage=ru&publishedAfter=${encodeURIComponent(after)}&q=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`, { retries: 1 });
  if (r.kind !== "ok") return { error: r.error };
  return { items: (r.data?.items || []).map((i) => ({ title: i.snippet?.title || "", url: `https://www.youtube.com/watch?v=${i.id?.videoId}`, channel: i.snippet?.channelTitle || "", published: i.snippet?.publishedAt || "" })) };
}

async function telegramChannel(handle) {
  const posts = [];
  let before = "";
  for (let page = 0; page < 3; page++) {
    const res = await fetch(`https://t.me/s/${handle}${before ? `?before=${before}` : ""}`, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(25_000) }).catch((e) => ({ ok: false, statusText: String(e?.message || e) }));
    if (!res.ok) return posts.length ? { posts } : { error: `витрина не открылась: ${res.status || res.statusText}` };
    const html = await res.text();
    const page_ = parseTelegram(html).map((p) => ({ title: p.title, url: p.url, views: parseViews(p.views), published: p.published }));
    if (!page_.length) break;
    posts.push(...page_);
    const min = Math.min(...page_.map((p) => Number(p.url.split("/").pop())).filter(Number.isFinite));
    if (!Number.isFinite(min) || min <= 1) break;
    before = String(min);
    await sleep(900);
  }
  return { posts };
}

async function vkWall(domain, token) {
  const r = await request(`https://api.vk.ru/method/wall.get?domain=${encodeURIComponent(domain)}&count=60&filter=owner&v=5.199`, { headers: { authorization: `Bearer ${token}` }, retries: 1 });
  if (r.kind !== "ok") return { error: r.error };
  return {
    posts: (r.data?.response?.items || []).filter((p) => !p.is_pinned && !p.marked_as_ads).map((p) => ({
      title: String(p.text || "").replace(/\s+/g, " ").slice(0, 140) || "(без текста)",
      url: `https://vk.com/wall${p.owner_id}_${p.id}`,
      views: Number(p.views?.count),
      likes: Number(p.likes?.count) || 0,
      comments: Number(p.comments?.count) || 0,
      published: new Date(p.date * 1000).toISOString(),
    })),
  };
}

export async function collect({ dry = false, sources = ["youtube", "rutube", "telegram", "vk"], search = false } = {}) {
  const list = readJson(WATCHLIST, {}) || {};
  const seen = new Set(readJsonl(OUT()).map((r) => r.url));
  const out = { found: 0, errors: [], channels: 0 };
  const save = (source, channel, item) => {
    if (seen.has(item.url)) return;
    seen.add(item.url);
    out.found++;
    if (!dry) appendJsonl(OUT(), { at: new Date().toISOString(), source, channel: channel.title || channel.id || channel.handle || channel.domain, why: channel.why || "", ...item });
    else console.log(`  ${String(item.ratio).padStart(5)}×  ${source}  ${(channel.title || "").slice(0, 24).padEnd(24)} ${item.title.slice(0, 70)}`);
  };

  const key = env("YOUTUBE_API_KEY");
  if (sources.includes("youtube")) {
    // С ключом берём 50 последних роликов канала, без ключа — открытую ленту на 15.
    for (const ch of list.youtube || []) {
      const r = key ? await youtubeChannel(ch.id, key) : await youtubeFeed(ch.id);
      if (r.error) { out.errors.push(`YouTube ${ch.title || ch.id}: ${r.error}`); continue; }
      out.channels++;
      for (const item of outliers(r.posts, { minViews: ch.minViews || 500 }).found) save("youtube", ch, item);
      await sleep(300);
    }
    if (key && search) for (const q of list.queries || []) {
      const r = await youtubeSearch(q, key);
      if (r.error) { out.errors.push(`поиск «${q}»: ${r.error}`); continue; }
      for (const item of r.items) save("youtube-поиск", { title: `запрос: ${q}` }, { ...item, ratio: 0, views: null, median: null });
    }
  }
  if (sources.includes("rutube")) for (const ch of list.rutube || []) {
    const r = await rutubeChannel(ch.id);
    if (r.error) { out.errors.push(`Rutube ${ch.title || ch.id}: ${r.error}`); continue; }
    out.channels++;
    for (const item of outliers(r.posts, { minViews: ch.minViews || 300 }).found) save("rutube", ch, item);
    await sleep(500);
  }
  if (sources.includes("telegram")) for (const ch of list.telegram || []) {
    const r = await telegramChannel(ch.handle);
    if (r.error) { out.errors.push(`Telegram ${ch.handle}: ${r.error}`); continue; }
    out.channels++;
    for (const item of outliers(r.posts, { factor: 2.5, minViews: ch.minViews || 300 }).found) save("telegram", ch, item);
    await sleep(900);
  }
  const vkToken = env("VK_SERVICE_TOKEN");
  if (sources.includes("vk")) {
    if (!vkToken) out.errors.push("ВКонтакте пропущен: нет VK_SERVICE_TOKEN");
    else for (const ch of list.vk || []) {
      const r = await vkWall(ch.domain, vkToken);
      if (r.error) { out.errors.push(`ВКонтакте ${ch.domain}: ${r.error}`); continue; }
      out.channels++;
      for (const item of outliers(r.posts, { minViews: ch.minViews || 500 }).found) save("vk", ch, item);
      await sleep(400);
    }
  }
  return out;
}

/** Сводка находок за последние дни для сессии S4. */
export function digest(rows, { now = Date.now(), days = 30, limit = 25 } = {}) {
  const fresh = rows.filter((r) => now - Date.parse(r.at) <= days * 86_400_000).sort((a, b) => (b.ratio || 0) - (a.ratio || 0)).slice(0, limit);
  const L = [`# Что зашло у других за ${days} дней`, "", "Число слева — во сколько раз публикация обогнала обычную для своего канала.", ""];
  if (!fresh.length) L.push("Находок нет: либо список каналов пуст, либо у всех обычная неделя.");
  for (const r of fresh) L.push(`- **${r.ratio ? `${String(r.ratio).replace(".", ",")}×` : "поиск"}** · ${r.source} · ${r.channel} · ${String(r.published || "").slice(0, 10)}\n  ${r.title}\n  ${r.url}${r.views ? ` · просмотров ${r.views}, обычно ${r.median}` : ""}`);
  return L.join("\n") + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (flag("digest")) {
    console.log(digest(readJsonl(OUT())));
  } else {
    const picked = ["youtube", "rutube", "telegram", "vk"].filter((s) => flag(s));
    collect({ dry: flag("dry"), sources: picked.length ? picked : undefined, search: flag("search") }).then(
      (r) => {
        console.log(`${new Date().toISOString()} каналов ${r.channels}, новых находок ${r.found}${r.errors.length ? `, пропусков ${r.errors.length}` : ""}`);
        for (const e of r.errors) console.error(`  ${e}`);
      },
      (e) => { console.error(`сбой слежения: ${e?.stack || e}`); process.exitCode = 2; },
    );
  }
}
