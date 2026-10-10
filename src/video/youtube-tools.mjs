// YouTube: всё, что делается с каналом кроме самой загрузки. Правка описаний, плейлисты,
// обложки, опись канала. Перенесено из наших боевых скриптов; у каждой оговорки свой случай.
//
//  · правка описания ЗАМЕЩАЕТ весь блок сведений ролика: пошлёшь одно описание — сотрёшь
//    название, метки и категорию. Сначала читаем текущий блок, правим в нём нужное;
//  · ролики в плейлист добавляются строго по одному и по порядку: параллельные добавления
//    площадка складывает как успеет, и первым окажется случайный ролик;
//  · свою обложку можно загрузить только на подтверждённом канале. У коротких роликов
//    обложкой остаётся кадр: его выбирают при монтаже;
//  · данные аналитики отстают на двое-трое суток: у свежего ролика пустой досмотр значит
//    «ещё не посчитано», а не «никто не досмотрел».

import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "../lib/env.mjs";
import { request } from "../lib/http.mjs";
import { accessToken, analytics, api } from "../channels/youtube.mjs";
import { median } from "../metrics/summary.mjs";

const API = "https://www.googleapis.com/youtube/v3";
const jsonInit = (method, body) => ({ method, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body), retries: 0 });

/** Длина ролика из записи вида PT1M23S в секундах. */
export function seconds(iso) {
  const m = String(iso || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : 0;
}

/** Сведения роликов пачками по 50. Ключа API хватает; без него идём правами владельца. */
export async function videos(ids, part = "snippet,statistics,contentDetails,status") {
  const out = [];
  const key = env("YOUTUBE_API_KEY");
  for (let i = 0; i < ids.length; i += 50) {
    const q = `videos?part=${part}&id=${ids.slice(i, i + 50).join(",")}`;
    // Сведения о доступе (status) у закрытых роликов отдаются только владельцу.
    const r = key && !part.includes("status") ? await request(`${API}/${q}&key=${encodeURIComponent(key)}`, { retries: 1 }) : await api(q);
    if (r.kind !== "ok") return { kind: r.kind, error: r.error, items: out };
    out.push(...(r.data?.items || []));
  }
  return { kind: "ok", items: out };
}

/** Правка названия, описания и меток вышедшего ролика без потери остальных сведений. */
export async function updateSnippet(id, patch) {
  const cur = await api(`videos?part=snippet&id=${encodeURIComponent(id)}`);
  const snippet = cur.data?.items?.[0]?.snippet;
  if (cur.kind !== "ok" || !snippet) return { ok: false, error: cur.error || `ролик ${id} не найден на канале` };
  const next = { ...snippet, ...(patch.title ? { title: patch.title } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}), ...(patch.tags ? { tags: patch.tags } : {}) };
  if (next.title === snippet.title && next.description === snippet.description && JSON.stringify(next.tags || []) === JSON.stringify(snippet.tags || [])) return { ok: true, changed: false, title: snippet.title };
  const r = await api("videos?part=snippet", jsonInit("PUT", { id, snippet: next }));
  if (r.kind !== "ok") return { ok: false, error: `правка не прошла: ${r.error}` };
  return { ok: true, changed: true, title: r.data?.snippet?.title || next.title };
}

export async function createPlaylist({ title, description = "" }) {
  const r = await api("playlists?part=snippet,status", jsonInit("POST", { snippet: { title, description, defaultLanguage: "ru" }, status: { privacyStatus: "public" } }));
  return r.kind === "ok" && r.data?.id ? { ok: true, id: r.data.id } : { ok: false, error: r.error || "YouTube не вернул номер плейлиста" };
}

/** Что лежит в плейлисте: номера роликов и номера их строк в плейлисте. */
export async function playlistItems(playlistId) {
  const out = [];
  let page = "";
  do {
    const r = await api(`playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${encodeURIComponent(playlistId)}${page ? `&pageToken=${page}` : ""}`);
    if (r.kind !== "ok") return { kind: r.kind, error: r.error, items: out };
    for (const it of r.data?.items || []) out.push({ itemId: it.id, videoId: it.contentDetails?.videoId, position: it.snippet?.position });
    page = r.data?.nextPageToken || "";
  } while (page);
  return { kind: "ok", items: out };
}

export async function addToPlaylist(playlistId, videoId, position) {
  const r = await api("playlistItems?part=snippet", jsonInit("POST", { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId }, ...(Number.isInteger(position) ? { position } : {}) } }));
  return r.kind === "ok" && r.data?.id ? { ok: true } : { ok: false, error: r.error };
}

/** Привести порядок плейлиста к заданному. Добавляет недостающие, переставляет остальные. */
export async function orderPlaylist(playlistId, orderedIds) {
  const cur = await playlistItems(playlistId);
  if (cur.kind !== "ok") return { ok: false, error: cur.error };
  const have = new Map(cur.items.map((i) => [i.videoId, i]));
  let added = 0;
  let moved = 0;
  for (let position = 0; position < orderedIds.length; position++) {
    const videoId = orderedIds[position];
    const item = have.get(videoId);
    if (!item) {
      const r = await addToPlaylist(playlistId, videoId, position);
      if (!r.ok) return { ok: false, error: `ролик ${videoId} не добавился: ${r.error}`, added, moved };
      added++;
    } else if (item.position !== position) {
      const r = await api("playlistItems?part=snippet", jsonInit("PUT", { id: item.itemId, snippet: { playlistId, resourceId: { kind: "youtube#video", videoId }, position } }));
      if (r.kind !== "ok") return { ok: false, error: `ролик ${videoId} не переставился: ${r.error}`, added, moved };
      moved++;
    }
  }
  return { ok: true, added, moved };
}

/** Своя обложка ролика (обычные ролики подтверждённого канала): 1280×720, до 2 МБ. */
export async function setThumbnail(videoId, file) {
  const t = await accessToken();
  if (t.kind !== "ok") return { ok: false, error: t.error };
  const type = path.extname(file).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
  const bytes = readFileSync(file);
  if (bytes.length > 2 * 1024 * 1024) return { ok: false, error: `обложка ${(bytes.length / 1048576).toFixed(1)} МБ, предел YouTube 2 МБ` };
  const res = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, { method: "POST", headers: { authorization: `Bearer ${t.token}`, "content-type": type, "content-length": String(bytes.length) }, body: bytes, signal: AbortSignal.timeout(120_000) });
  if (res.ok) return { ok: true };
  const text = await res.text();
  return { ok: false, error: /forbidden|403/i.test(text) ? "YouTube не принял обложку: свои обложки доступны только подтверждённому каналу (Студия → Настройки → Канал → Доступность функций)" : `обложка не принята (${res.status}): ${text.slice(0, 200)}` };
}

/**
 * Опись канала: все ролики с цифрами. Чистая часть расчёта вынесена в describeChannel.
 * @returns {Promise<{ kind: string, error?: string, snapshot?: object }>}
 */
export async function channelSnapshot({ withAnalytics = false } = {}) {
  const channelId = env("YOUTUBE_CHANNEL_ID");
  const key = env("YOUTUBE_API_KEY");
  const ch = channelId && key ? await request(`${API}/channels?part=contentDetails,statistics,snippet&id=${encodeURIComponent(channelId)}&key=${encodeURIComponent(key)}`, { retries: 1 }) : await api("channels?part=contentDetails,statistics,snippet&mine=true");
  const c = ch.data?.items?.[0];
  if (ch.kind !== "ok" || !c) return { kind: ch.kind === "ok" ? "refused" : ch.kind, error: ch.error || "канал не найден: проверьте YOUTUBE_CHANNEL_ID" };
  const uploads = c.contentDetails?.relatedPlaylists?.uploads;
  // Берём все загрузки, а не «последние сто»: иначе старые ролики молча выпадают из медианы.
  const ids = [];
  let page = "";
  do {
    const q = `playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}${page ? `&pageToken=${page}` : ""}`;
    const r = key ? await request(`${API}/${q}&key=${encodeURIComponent(key)}`, { retries: 1 }) : await api(q);
    if (r.kind !== "ok") return { kind: r.kind, error: r.error };
    ids.push(...(r.data?.items || []).map((i) => i.contentDetails.videoId));
    page = r.data?.nextPageToken || "";
  } while (page);
  const v = await videos(ids, "snippet,statistics,contentDetails");
  if (v.kind !== "ok") return { kind: v.kind, error: v.error };
  let watch = new Map();
  let analyticsUntil = "";
  if (withAnalytics) {
    const a = await analytics(ids);
    if (a.kind !== "ok") return { kind: a.kind, error: `аналитика не снята: ${a.error}. Нужен вход владельца канала с правом на аналитику: npm run yt -- --login` };
    watch = a.byId;
    analyticsUntil = a.until;
  }
  return { kind: "ok", snapshot: describeChannel({ channel: c, items: v.items, watch, analyticsUntil }) };
}

/** Расчёт описи: отрыв от медианы канала и отклик на сотню просмотров. Чистая функция. */
export function describeChannel({ channel, items, watch = new Map(), analyticsUntil = "", now = Date.now() }) {
  const list = items.map((it) => {
    const st = it.statistics || {};
    const sec = seconds(it.contentDetails?.duration);
    const views = Number(st.viewCount) || 0;
    const likes = Number(st.likeCount) || 0;
    const comments = Number(st.commentCount) || 0;
    return {
      id: it.id,
      url: `https://www.youtube.com/watch?v=${it.id}`,
      title: String(it.snippet?.title || "").trim(),
      date: String(it.snippet?.publishedAt || "").slice(0, 10),
      seconds: sec,
      // Отдельного признака короткого ролика площадка не отдаёт: судим по длине.
      short: sec > 0 && sec <= 180,
      views, likes, comments,
      // Отклик считаем на сотню просмотров: иначе «зашло» превращается в «показали многим».
      per100: views ? Number((((likes + comments) / views) * 100).toFixed(2)) : null,
      ...(watch.get(it.id) || {}),
    };
  });
  const med = median(list.map((x) => x.views));
  for (const x of list) x.ratio = med ? Number((x.views / med).toFixed(2)) : null;
  list.sort((a, b) => b.views - a.views);
  return {
    channelId: channel.id,
    title: channel.snippet?.title || "",
    subscribers: Number(channel.statistics?.subscriberCount) || 0,
    taken: new Date(now).toISOString(),
    analyticsUntil: analyticsUntil || null,
    videos: list.length,
    shorts: list.filter((x) => x.short).length,
    medianViews: med,
    list,
  };
}
