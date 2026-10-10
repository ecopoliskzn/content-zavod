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

/** Вызов Data API с правами владельца канала. Им же пользуются инструменты серий и описаний. */
export async function api(pathAndQuery, init = {}) {
  const t = await accessToken();
  if (t.kind !== "ok") return { kind: t.kind, error: t.error, data: null };
  return request(`${API}/${pathAndQuery}`, { ...init, headers: { authorization: `Bearer ${t.token}`, ...(init.headers || {}) }, retries: init.retries ?? 1 });
}

/**
 * Досмотр и подписки с ролика: Analytics API, только с входом владельца канала.
 *
 * Просмотры отвечают на вопрос «сколько показали», досмотр — «удержал ли ролик». Для
 * решения, что снимать дальше, нужен второй. Данные сервис отдаёт с опозданием на
 * двое-трое суток, поэтому конец окна берётся с запасом в три дня: спросив «по сегодня»,
 * получили бы нули у свежих роликов и решили бы, что ролик провалился.
 * @param {string[]} ids номера роликов, до 200 за вызов
 * @returns {Promise<{ kind: string, error?: string, until?: string, byId?: Map<string, { minutes: number, avgSec: number, watchPct: number, subs: number }> }>}
 */
export async function analytics(ids) {
  const t = await accessToken();
  if (t.kind !== "ok") return { kind: t.kind, error: t.error };
  const until = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  const byId = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const q = new URLSearchParams({
      ids: "channel==MINE", startDate: "2015-01-01", endDate: until, dimensions: "video", maxResults: "200",
      filters: `video==${ids.slice(i, i + 200).join(",")}`,
      metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained",
    });
    const r = await request(`https://youtubeanalytics.googleapis.com/v2/reports?${q}`, { headers: { authorization: `Bearer ${t.token}` }, retries: 1 });
    if (r.kind !== "ok") return { kind: r.kind, error: r.error };
    for (const [id, , minutes, avgSec, pct, subs] of r.data?.rows || []) {
      byId.set(id, { minutes: Math.round(Number(minutes) || 0), avgSec: Math.round(Number(avgSec) || 0), watchPct: Number((Number(pct) || 0).toFixed(1)), subs: Number(subs) || 0 });
    }
  }
  return { kind: "ok", until, byId };
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

/* Поля блока status, которые YouTube принимает в правке. Остальное в ответе (ход загрузки,
   причина отказа, признак «для детей», выставленный площадкой) только для чтения. */
const WRITABLE = ["privacyStatus", "publishAt", "embeddable", "license", "publicStatsViewable", "selfDeclaredMadeForKids", "containsSyntheticMedia"];
const writable = (st) => Object.fromEntries(WRITABLE.filter((k) => st?.[k] !== undefined).map((k) => [k, st[k]]));
const putStatus = (id, next) => api("videos?part=status", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, status: next }), retries: 0 });

/** Открыть закрытый ролик. Статус замещается целиком, поэтому сначала читаем текущий. */
async function makePublic(video) {
  const next = { ...writable(video.status), privacyStatus: "public" };
  delete next.publishAt;
  return putStatus(video.id, next);
}

/**
 * Поставить, переставить или снять срок выхода закрытого ролика.
 *
 * Срок на YouTube — вторые часы выпуска, и очередь их не видит: «Снять» и «Отозвать
 * согласие» останавливают запись, а YouTube в назначенную минуту открывает ролик сам.
 * Поэтому срок следует за записью: src/video/schedule.mjs.
 *
 * publishAt = "" снимает срок: ролик остаётся закрытым. Правка замещает блок status
 * целиком, поле, которого нет в запросе, YouTube стирает: так срок и снимается.
 *
 * СТАТУС: написано по документации Data API, боем не проверено. Поэтому после правки
 * ролик читается заново, и «сделано» говорится только по тому, что ответил YouTube.
 * @param {{ id: string, status: object }} video ролик, как его вернул status().raw
 * @param {string} publishAt срок в ISO либо пустая строка
 */
export async function setSchedule(video, publishAt) {
  const next = { ...writable(video.status), privacyStatus: "private" };
  delete next.publishAt;
  if (publishAt) next.publishAt = publishAt;
  const r = await putStatus(video.id, next);
  if (r.kind !== "ok") return { ok: false, kind: r.kind, error: r.error };
  const check = await status(video.id);
  if (check.kind !== "ok") return { ok: false, kind: check.kind, error: `правка ушла, но перечитать ролик не удалось: ${check.error}` };
  const got = check.publishAt ? Date.parse(check.publishAt) : 0;
  const want = publishAt ? Date.parse(publishAt) : 0;
  if (check.privacy !== "private") return { ok: false, kind: "refused", error: `после правки ролик не закрыт (доступ «${check.privacy}»)` };
  if (Math.abs(got - want) > 60_000) return { ok: false, kind: "refused", error: publishAt ? `YouTube не принял срок выхода: на ролике стоит «${check.publishAt || "без срока"}»` : `YouTube не снял срок выхода: на ролике по-прежнему стоит ${check.publishAt}` };
  return { ok: true };
}

/**
 * Ролик уже открыт на YouTube? Нужно выпуску перед тем, как объявить запись просроченной:
 * после долгого простоя сервера ролик с датой выхода давно открыт самим YouTube, и
 * сообщение «не вышла» было бы неправдой.
 * @returns {Promise<{ id: string, link: string } | null>}
 */
export async function already(entry) {
  const id = entry.extra?.youtubeId;
  if (!id) return null;
  const s = await status(id);
  return s.kind === "ok" && s.privacy === "public" ? { id, link: `https://www.youtube.com/watch?v=${id}` } : null;
}

/**
 * Слот наступил: сверяем, что ролик открыт. Номер ролика лежит в entry.extra.youtubeId,
 * его туда кладёт видео-сессия после загрузки.
 */
export async function publish(entry, ctx = {}) {
  const id = entry.extra?.youtubeId || entry.result?.youtubeId;
  if (!id) return { ok: false, retry: false, error: "ролик не загружен на YouTube. Загрузка идёт с компьютера оператора: npm run yt -- --upload --id=<номер записи> --file=<путь>" };
  /* Запись правили после загрузки: в очереди одобрен новый текст, а на ролике лежат прежние
     название и описание. Открыть такой ролик значит выпустить то, чему сказали «нет».
     Отпечаток отправленного содержимого пишут загрузка и команда --update. */
  if (entry.extra?.youtubeHash !== entry.contentHash) return { ok: false, retry: false, error: `на ролике на YouTube лежат прежние название и описание, а одобрены новые. Оператору: npm run yt -- --update --id=${entry.name}, затем кнопка «Вернуть в ближайший слот»` };
  const s = await status(id);
  if (s.kind !== "ok") return { ok: false, error: `YouTube не отвечает про ролик: ${s.error}`, retry: s.kind === "network" };
  const link = `https://www.youtube.com/watch?v=${id}`;
  if (s.upload === "rejected" || s.upload === "failed") return { ok: false, retry: false, error: `YouTube отклонил ролик: ${s.rejection || s.upload}` };
  if (s.privacy !== "public") {
    // Слот записи наступил, значит, ролик пора открывать, какой бы срок ни стоял на самом
    // YouTube: хозяин расписания — очередь. Срок там может быть позже слота (запись
    // переставили ближе) либо снят вовсе (выпуск останавливали).
    const opened = await makePublic(s.raw);
    if (opened.kind !== "ok") return { ok: false, error: `ролик не открылся: ${opened.error}`, retry: opened.kind === "network" };
    await sleep(3_000);
    const check = await status(id);
    if (check.kind === "ok" && check.privacy !== "public") return { ok: false, retry: false, error: "YouTube оставил ролик закрытым: проект Google не прошёл проверку. Откройте ролик руками в Студии и подайте проект на аудит" };
  }
  await askPin(entry, link, ctx);
  return { ok: true, id, link };
}

/**
 * Закреплённый комментарий: один из трёх переходов у короткого ролика (два других —
 * плейлист и обложка). Закрепить комментарий программа не может, это делает человек в
 * Студии. Текст приходит ему в рабочую группу в момент выхода ролика. Один раз на запись.
 */
async function askPin(entry, link, ctx) {
  if (entry.result?.pinAsked || entry.pin === false) return;
  try {
    const { pinText } = await import("../video/describe.mjs");
    const { h, toGroup } = await import("../lib/notify.mjs");
    const text = pinText(entry);
    const sent = await toGroup("packages", `📌 <b>Закрепить комментарий · YouTube</b>\nРолик вышел: ${h(link)}\n\n1. Откройте ролик с аккаунта канала.\n2. Оставьте комментарий с текстом из следующего сообщения.\n3. Нажмите на три точки у комментария и выберите «Закрепить».`);
    if (sent.ok) {
      await toGroup("packages", h(text), { extra: { reply_parameters: { message_id: sent.messageId } } });
      if (ctx.onState) await ctx.onState({ pinAsked: true });
    }
  } catch (e) {
    // Просьба о комментарии не должна ронять выпуск: ролик уже вышел.
    console.error("[youtube] просьба закрепить комментарий не ушла:", e?.message || e);
  }
}

/** Номер ролика из номера публикации или из ссылки. */
export function videoId(value) {
  const s = String(value || "");
  if (/^[\w-]{11}$/.test(s)) return s;
  return s.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/)?.[1] || "";
}

/**
 * Цифры роликов: просмотры, отметки и комментарии пачкой до 50, плюс досмотр и подписки
 * с ролика, если есть вход владельца канала. Без него остаются только просмотры: для
 * вопроса «о чём снимать дальше» этого мало, поэтому вход берётся с правом на аналитику.
 */
export async function metrics(items) {
  const out = [];
  const pairs = items.map((x) => ({ externalId: x.externalId, id: videoId(x.externalId) || videoId(x.link) }));
  const known = pairs.filter((p) => p.id);
  for (const p of pairs) if (!p.id) out.push({ externalId: p.externalId, error: "нет номера ролика", kind: "refused" });
  const rows = new Map();
  for (let i = 0; i < known.length; i += 50) {
    const ids = known.slice(i, i + 50).map((x) => x.id);
    const key = env("YOUTUBE_API_KEY");
    const r = key ? await request(`${API}/videos?part=statistics&id=${ids.join(",")}&key=${encodeURIComponent(key)}`, { retries: 1 }) : await api(`videos?part=statistics&id=${ids.join(",")}`);
    if (r.kind !== "ok") { for (const id of ids) rows.set(id, { error: r.error, kind: r.kind }); continue; }
    const byId = new Map((r.data?.items || []).map((v) => [v.id, v.statistics]));
    for (const id of ids) {
      const st = byId.get(id);
      rows.set(id, st ? { views: Number(st.viewCount) || 0, likes: Number(st.likeCount) || 0, comments: Number(st.commentCount) || 0 } : { error: "ролик не найден", kind: "refused" });
    }
  }
  // Досмотр не обязателен: нет входа или сервис не ответил — цифры просмотров всё равно уходят.
  if (env("YOUTUBE_REFRESH_TOKEN") && known.length) {
    const a = await analytics(known.map((x) => x.id)).catch((e) => ({ kind: "network", error: String(e?.message || e) }));
    if (a.kind === "ok") for (const [id, v] of a.byId) if (rows.has(id) && !rows.get(id).error) Object.assign(rows.get(id), { watchPct: v.watchPct, avgSec: v.avgSec, subs: v.subs, analyticsUntil: a.until });
  }
  for (const p of known) out.push({ externalId: p.externalId, ...rows.get(p.id) });
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
