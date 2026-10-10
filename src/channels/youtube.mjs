// YouTube: загрузка ролика, отложенный выход, сверка, цифры.
//
// СТАТУС: загрузка перенесена из нашего боевого скрипта (своим ключом, без посредника).
//
// КТО ЧТО ДЕЛАЕТ. Файл лежит на компьютере оператора, поэтому ЗАГРУЗКУ делает видео-
// сессия оттуда: ролик уходит закрытым, с датой выхода (publishAt), и YouTube открывает
// его сам. Сервер в слот только СВЕРЯЕТ, что ролик открылся, и пишет ссылку в журнал.
// Так выход не зависит ни от включённого компьютера в час слота, ни от скорости канала
// сервера до Google.
//
// Грабли, за которые уже заплачено:
//  · нужное API в проекте Google включается отдельно, по умолчанию оно выключено;
//  · пока экран согласия OAuth в статусе «Тестирование», ключ обновления живёт 7 дней.
//    Для постоянной работы приложение переводят в «В продакшене»;
//  · права задним числом к выданному ключу не добавляются: нужен новый вход;
//  · тело загрузки — БУФЕР, а не поток. Потоком через fetch на Node 24 отправка рвётся
//    без внятной причины;
//  · ответ сразу после загрузки не значит «готово»: идёт обработка, статус читаем отдельно;
//  · ролик из нового проекта Google YouTube может принудительно оставить закрытым. В
//    документации на 10.2026 написано и «не ограничиваются», и обратное, поэтому после
//    первой же загрузки читаем статус у самого YouTube. Просили открыть, а он закрыт —
//    говорим об этом прямо, а не отчитываемся об успехе;
//  · вертикаль до трёх минут площадка сама считает коротким роликом, помечать не нужно;
//  · отложенный выход работает только у закрытого ролика, который ни разу не открывался;
//  · у загрузок своя суточная квота (с 01.06.2026: 100 вызовов), у поиска своя.

import { readFileSync, statSync } from "node:fs";
import { env } from "../lib/env.mjs";
import { request, sleep } from "../lib/http.mjs";

export const name = "youtube";
const API = "https://www.googleapis.com/youtube/v3";

let cached = { token: "", until: 0 };

/** Маркер доступа по ключу обновления. Живёт час, держим в памяти процесса. */
export async function accessToken() {
  if (cached.token && Date.now() < cached.until) return { kind: "ok", token: cached.token };
  const id = env("YOUTUBE_CLIENT_ID");
  const secret = env("YOUTUBE_CLIENT_SECRET");
  const refresh = env("YOUTUBE_REFRESH_TOKEN");
  if (!id || !secret || !refresh) return { kind: "refused", error: "нет YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET или YOUTUBE_REFRESH_TOKEN" };
  const r = await request("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }),
    retries: 1,
  });
  if (r.kind !== "ok" || !r.data?.access_token) {
    // invalid_grant — ключ обновления отозван или протух (семь дней в режиме «Тестирование»).
    return { kind: r.kind === "network" ? "network" : "refused", error: r.data?.error === "invalid_grant" ? "ключ обновления YouTube протух или отозван: нужен новый вход владельца канала" : r.error };
  }
  cached = { token: r.data.access_token, until: Date.now() + (Number(r.data.expires_in) - 120) * 1000 };
  return { kind: "ok", token: cached.token };
}

async function api(pathAndQuery, init = {}) {
  const t = await accessToken();
  if (t.kind !== "ok") return { kind: t.kind, error: t.error, data: null };
  return request(`${API}/${pathAndQuery}`, { ...init, headers: { authorization: `Bearer ${t.token}`, ...(init.headers || {}) }, retries: init.retries ?? 1 });
}

/**
 * Загрузка ролика с диска. С датой выхода ролик уходит закрытым и откроется сам.
 * @param {{ file: string, title: string, description?: string, tags?: string[], publishAt?: string, privacy?: "public"|"private"|"unlisted", categoryId?: string }} v
 * @returns {Promise<{ ok: boolean, id?: string, privacy?: string, error?: string, warning?: string }>}
 */
export async function upload(v) {
  const t = await accessToken();
  if (t.kind !== "ok") return { ok: false, error: t.error };
  const size = statSync(v.file).size;
  const privacy = v.publishAt ? "private" : v.privacy || "private";
  // Шаг 1: открыть сессию. Описание уходит здесь, а не вместе с байтами: ошибка в
  // описании видна сразу, до отправки сотен мегабайт.
  const start = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json; charset=utf-8", "x-upload-content-length": String(size), "x-upload-content-type": "video/mp4" },
    body: JSON.stringify({
      snippet: { title: v.title, description: v.description || "", tags: v.tags || [], categoryId: v.categoryId || "22", defaultLanguage: "ru", defaultAudioLanguage: "ru" },
      status: { privacyStatus: privacy, selfDeclaredMadeForKids: false, ...(v.publishAt ? { publishAt: v.publishAt } : {}) },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!start.ok) return { ok: false, error: `сессия загрузки не открылась (${start.status}): ${(await start.text()).slice(0, 300)}` };
  const location = start.headers.get("location");
  if (!location) return { ok: false, error: "Google не вернул адрес загрузки" };
  // Шаг 2: байты одним куском. Файл, который не влезает в память, нужно резать по
  // Content-Range; до этого размера ролики завода не доходят.
  const put = await fetch(location, { method: "PUT", headers: { "content-length": String(size), "content-type": "video/mp4" }, body: readFileSync(v.file), signal: AbortSignal.timeout(30 * 60_000) });
  const data = await put.json().catch(() => ({}));
  if (!put.ok || !data.id) return { ok: false, error: `загрузка не прошла (${put.status}): ${JSON.stringify(data).slice(0, 300)}` };
  const got = data.status?.privacyStatus;
  const warning = got && got !== privacy ? `просили «${privacy}», YouTube поставил «${got}»: так он поступает с роликами непроверенного проекта` : "";
  return { ok: true, id: data.id, privacy: got, warning };
}

/** Что YouTube думает о ролике прямо сейчас. */
export async function status(id) {
  const r = await api(`videos?part=status,snippet&id=${encodeURIComponent(id)}`);
  if (r.kind !== "ok") return { kind: r.kind, error: r.error };
  const v = r.data?.items?.[0];
  if (!v) return { kind: "refused", error: "ролика с таким номером на канале нет" };
  return { kind: "ok", privacy: v.status.privacyStatus, publishAt: v.status.publishAt || "", upload: v.status.uploadStatus, rejection: v.status.rejectionReason || "", title: v.snippet.title, raw: v };
}

/** Открыть закрытый ролик. Статус замещается целиком, поэтому сначала читаем текущий. */
async function makePublic(video) {
  const next = { ...video.status, privacyStatus: "public" };
  delete next.publishAt;
  return api("videos?part=status", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: video.id, status: next }), retries: 0 });
}

/**
 * Слот наступил: сверяем, что ролик открыт. Номер ролика лежит в entry.extra.youtubeId,
 * его туда кладёт видео-сессия после загрузки.
 */
export async function publish(entry) {
  const id = entry.extra?.youtubeId || entry.result?.youtubeId;
  if (!id) return { ok: false, retry: false, error: "ролик не загружен на YouTube. Загрузка идёт с компьютера оператора: npm run yt -- --upload --id=<номер записи> --file=<путь>" };
  const s = await status(id);
  if (s.kind !== "ok") return { ok: false, error: `YouTube не отвечает про ролик: ${s.error}`, retry: s.kind === "network" };
  const link = `https://www.youtube.com/watch?v=${id}`;
  if (s.upload === "rejected" || s.upload === "failed") return { ok: false, retry: false, error: `YouTube отклонил ролик: ${s.rejection || s.upload}` };
  if (s.privacy === "public") return { ok: true, id, link };
  if (s.publishAt && Date.parse(s.publishAt) > Date.now() + 2 * 60_000) return { ok: false, retry: true, error: `YouTube откроет ролик сам в ${s.publishAt}, пока рано` };
  const opened = await makePublic(s.raw);
  if (opened.kind !== "ok") return { ok: false, error: `ролик не открылся: ${opened.error}`, retry: opened.kind === "network" };
  await sleep(3_000);
  const check = await status(id);
  if (check.kind === "ok" && check.privacy !== "public") return { ok: false, retry: false, error: "YouTube оставил ролик закрытым: проект Google не прошёл проверку. Откройте ролик руками в Студии и подайте проект на аудит" };
  return { ok: true, id, link };
}

/** Просмотры, отметки и комментарии пачкой до 50 роликов. */
export async function metrics(items) {
  const out = [];
  for (let i = 0; i < items.length; i += 50) {
    const ids = items.slice(i, i + 50).map((x) => x.externalId);
    const key = env("YOUTUBE_API_KEY");
    const r = key ? await request(`${API}/videos?part=statistics&id=${ids.join(",")}&key=${encodeURIComponent(key)}`, { retries: 1 }) : await api(`videos?part=statistics&id=${ids.join(",")}`);
    if (r.kind !== "ok") { for (const id of ids) out.push({ externalId: id, error: r.error, kind: r.kind }); continue; }
    const byId = new Map((r.data?.items || []).map((v) => [v.id, v.statistics]));
    for (const id of ids) {
      const st = byId.get(id);
      out.push(st ? { externalId: id, views: Number(st.viewCount) || 0, likes: Number(st.likeCount) || 0, comments: Number(st.commentCount) || 0 } : { externalId: id, error: "ролик не найден", kind: "refused" });
    }
  }
  return out;
}

/** Добавить ролик в плейлист (серии ведут зрителя дальше одного ролика). */
export async function addToPlaylist(playlistId, videoId) {
  return api("playlistItems?part=snippet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } }) });
}

/** Подписчики канала: для недельного отчёта. Хватает открытого ключа API. */
export async function followers() {
  const id = env("YOUTUBE_CHANNEL_ID");
  const key = env("YOUTUBE_API_KEY");
  const r = id && key ? await request(`${API}/channels?part=statistics&id=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}`, { retries: 1 }) : await api("channels?part=statistics&mine=true");
  const count = Number(r.data?.items?.[0]?.statistics?.subscriberCount);
  return r.kind === "ok" && Number.isFinite(count) ? count : null;
}

/** Проверка для doctor: ключ жив и канал тот, что ждём. */
export async function probe() {
  const r = await api("channels?part=snippet,statistics&mine=true");
  if (r.kind !== "ok") return r;
  const c = r.data?.items?.[0];
  if (!c) return { kind: "refused", error: "у аккаунта, выдавшего ключ, нет канала" };
  const expected = env("YOUTUBE_CHANNEL_ID");
  if (expected && c.id !== expected) return { kind: "refused", error: `ключ выдан для другого канала (${c.snippet.title}): вход сделан не тем аккаунтом Google` };
  return { kind: "ok", detail: `канал «${c.snippet.title}», подписчиков ${c.statistics?.subscriberCount ?? "?"}, роликов ${c.statistics?.videoCount ?? "?"}` };
}
