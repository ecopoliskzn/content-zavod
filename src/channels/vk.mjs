// ВКонтакте: запись на стену сообщества, фото, видео, цифры.
//
// СТАТУС ПО ЧАСТЯМ (10.10.2026):
//  · текст со ссылкой ключом сообщества — работает в нашем проекте. В документации
//    ВКонтакте такого права у ключа сообщества нет, на деле запись проходит;
//  · фото и видео — только ключом администратора сообщества (ключ пользователя с правами
//    wall, photos, video). Ключом сообщества загрузка фото отвечает ошибкой 27. Этот
//    путь написан по документации и БОЕМ НЕ ПРОВЕРЕН;
//  · нет ключа администратора — запись с фото или видео уходит пакетом на ручную
//    выкладку в рабочую группу. Так площадка работает с первого дня.
//
// ЧТО НУЖНО ЗНАТЬ ПРО КЛЮЧ АДМИНИСТРАТОРА.
//  · новые ключи пользователя выдаёт только VK ID. Ключ живёт час и обновляется по
//    ключу обновления; при каждом обновлении прежняя пара гаснет. Поэтому ключ живёт в
//    одном месте, на сервере, а обновление идёт под замком: два процесса, обновившие
//    ключ одновременно, оставили бы завод без него;
//  · права wall, photos и video для приложения VK ID выдаются по запросу в поддержку
//    (devsupport@corp.vk.com). Осенью 2026 года встречаются сообщения, что поддержка
//    такие доступы не выдаёт. До ответа работает ручной пакет;
//  · без подтверждённого профиля бизнеса у приложения 10 000 вызовов в месяц. Заводу
//    этого хватает с запасом, если не читать стену каждую минуту.
//
// Адрес API: api.vk.ru (не api.vk.com), ключ в заголовке Authorization: Bearer.
// Клипы программно не публикуются: метода в справочнике нет. Вертикальный ролик уходит
// как обычное видео, клип из него делает человек в приложении.

import { randomBytes } from "node:crypto";
import { dataPath, env, _reset } from "../lib/env.mjs";
import { setEnv } from "../lib/envfile.mjs";
import { lock } from "../lib/files.mjs";
import { form, request, sleep as realSleep } from "../lib/http.mjs";
import { describe } from "../video/describe.mjs";
import { sendPackage } from "./manual.mjs";

export const name = "vk";
const API = "https://api.vk.ru/method";
const V = "5.199";
const TEMPORARY = new Set([1, 6, 9, 10]); // неизвестная ошибка, слишком часто, флуд, сбой сервера

const groupId = () => env("VK_GROUP_ID").replace(/^-/, "");
const plain = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Вызов метода API. Временные ошибки ВКонтакте приводятся к виду «сеть»: повтор имеет смысл. */
async function call(method, params, token, { retries = 1, timeoutMs = 30_000 } = {}) {
  const f = form({ ...params, v: V });
  const r = await request(`${API}/${method}`, { ...f, headers: { ...f.headers, authorization: `Bearer ${token}` }, retries, retryDelayMs: 4_000, timeoutMs });
  const code = r.data?.error?.error_code;
  if (r.kind === "refused" && TEMPORARY.has(code)) return { ...r, kind: "network", code };
  return { ...r, code, response: r.data?.response };
}

/**
 * Ключ администратора сообщества: при необходимости обновляется.
 * @returns {Promise<{ token: string, error?: string }>}
 */
export async function userToken() {
  const access = env("VK_USER_TOKEN");
  if (!access) return { token: "" };
  const fresh = () => { const t = Date.parse(env("VK_USER_TOKEN_EXPIRES")); return !Number.isFinite(t) || t - Date.now() > 5 * 60_000; };
  if (fresh()) return { token: access }; // срок не задан — это старый бессрочный ключ
  if (!env("VK_USER_REFRESH_TOKEN")) return { token: "", error: "ключ администратора ВКонтакте истёк, ключа обновления нет: нужен новый вход (node src/tokens/vk-login.mjs --url)" };
  const release = lock(dataPath("vk-refresh.lock"), 60_000);
  if (!release) {
    // Ключ прямо сейчас обновляет другой процесс: ждём и берём то, что он записал.
    await realSleep(4_000);
    _reset();
    return fresh() ? { token: env("VK_USER_TOKEN") } : { token: "", error: "ключ администратора ВКонтакте обновляется другим процессом" };
  }
  try {
    _reset();
    if (fresh()) return { token: env("VK_USER_TOKEN") };
    const r = await request("https://id.vk.ru/oauth2/auth", form({ grant_type: "refresh_token", refresh_token: env("VK_USER_REFRESH_TOKEN"), client_id: env("VK_APP_ID"), device_id: env("VK_DEVICE_ID"), state: randomBytes(12).toString("hex") }));
    if (r.kind !== "ok" || !r.data?.access_token) return { token: "", error: `ключ администратора ВКонтакте не обновился: ${r.error || "ВКонтакте не вернул новый ключ"}. Нужен новый вход администратора` };
    setEnv({
      VK_USER_TOKEN: r.data.access_token,
      VK_USER_REFRESH_TOKEN: r.data.refresh_token || env("VK_USER_REFRESH_TOKEN"),
      VK_USER_TOKEN_EXPIRES: new Date(Date.now() + (Number(r.data.expires_in) || 3600) * 1000).toISOString(),
    });
    return { token: r.data.access_token };
  } finally {
    release();
  }
}

async function bytesOf(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`хранилище ответило ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function uploadPhoto(url, token) {
  const server = await call("photos.getWallUploadServer", { group_id: groupId() }, token);
  if (server.kind !== "ok") return { error: `адрес загрузки фото не выдан: ${server.error}`, retry: server.kind === "network" };
  const body = new FormData();
  body.append("photo", new Blob([await bytesOf(url)]), decodeURIComponent(new URL(url).pathname.split("/").pop() || "photo.jpg"));
  const up = await request(server.response.upload_url, { method: "POST", body, timeoutMs: 120_000 });
  if (up.kind !== "ok" || !up.data?.photo || up.data.photo === "[]") return { error: `фото не загрузилось: ${up.error || "ВКонтакте не принял файл"}`, retry: up.kind === "network" };
  const saved = await call("photos.saveWallPhoto", { group_id: groupId(), photo: up.data.photo, server: up.data.server, hash: up.data.hash }, token);
  const p = saved.response?.[0];
  if (saved.kind !== "ok" || !p) return { error: `фото не сохранилось: ${saved.error}`, retry: saved.kind === "network" };
  return { attachment: `photo${p.owner_id}_${p.id}` };
}

async function uploadVideo(entry, url, token) {
  const saved = await call("video.save", { name: plain(entry.title || entry.text || entry.name).slice(0, 120), description: plain(entry.text).slice(0, 4900), group_id: groupId(), wallpost: 0 }, token);
  if (saved.kind !== "ok" || !saved.response?.upload_url) return { error: `адрес загрузки видео не выдан: ${saved.error}`, retry: saved.kind === "network" };
  const body = new FormData();
  body.append("video_file", new Blob([await bytesOf(url)]), "video.mp4");
  const up = await request(saved.response.upload_url, { method: "POST", body, timeoutMs: 30 * 60_000 });
  if (up.kind !== "ok") return { error: `видео не загрузилось: ${up.error}`, retry: up.kind === "network" };
  return { attachment: `video${saved.response.owner_id}_${saved.response.video_id}` };
}

/** Запись уже стоит на стене? Ищем по началу текста среди последних пяти. */
async function findOnWall(text, token) {
  if (!token) return null;
  const r = await call("wall.get", { owner_id: `-${groupId()}`, count: 5, filter: "owner" }, token, { retries: 0 });
  const start = plain(text).slice(0, 60);
  const post = (r.response?.items || []).find((p) => start && String(p.text || "").startsWith(start));
  return post ? post.id : null;
}

/**
 * @param {{ kind: string, text?: string, title?: string, link?: string, media?: Array<{type:string,url:string}>, result?: object }} entry
 */
export async function publish(raw, ctx = {}) {
  if (!groupId()) return { ok: false, retry: false, error: "нет VK_GROUP_ID" };
  // У ролика под текстом стоит блок ссылок с меткой площадки: тот же, что у YouTube.
  const entry = raw.kind === "video" ? { ...raw, text: describe(raw) } : raw;
  const media = entry.media || [];
  const user = await userToken();
  const community = env("VK_GROUP_TOKEN");
  const manual = (why) => sendPackage(entry, {
    onState: ctx.onState,
    why,
    steps: [
      "Откройте сообщество ВКонтакте и нажмите «Создать запись».",
      "Вставьте текст из следующего сообщения. Проверьте, что запись выходит от имени сообщества.",
      "Прикрепите файлы по ссылкам ниже: скачайте их и добавьте к записи.",
      "Нажмите «Опубликовать».",
      "Вернитесь сюда: нажмите «Выложено» и ответьте на это сообщение ссылкой на запись.",
    ],
  });

  if (media.length && !user.token) return manual(user.error || "Фото и видео во ВКонтакте загружает только ключ администратора сообщества, а его у завода пока нет.");
  if (!user.token && !community) return { ok: false, retry: false, error: "нет ни VK_GROUP_TOKEN, ни VK_USER_TOKEN" };

  // Повтор после обрыва: сначала смотрим, не вышла ли запись в прошлый раз.
  if (ctx.verify) {
    const found = await findOnWall(entry.text, env("VK_SERVICE_TOKEN") || user.token);
    if (found) return { ok: true, id: `-${groupId()}_${found}`, link: `https://vk.com/wall-${groupId()}_${found}` };
  }

  const attachments = [...(entry.result?.vkAttachments || [])];
  if (media.length && !attachments.length) {
    try {
      for (const m of media.slice(0, 10)) {
        const res = m.type === "video" ? await uploadVideo(entry, m.url, user.token) : await uploadPhoto(m.url, user.token);
        if (!res.attachment) return { ok: false, retry: res.retry !== false, error: res.error };
        attachments.push(res.attachment);
      }
    } catch (e) {
      return { ok: false, retry: true, error: `файл не забрался из хранилища: ${e.message}` };
    }
    // Загруженное запоминаем: повтор не зальёт фото и видео второй раз.
    if (ctx.onState) await ctx.onState({ vkAttachments: attachments });
  }
  if (entry.link) attachments.push(entry.link);

  const params = { owner_id: `-${groupId()}`, from_group: 1, message: plain(entry.kind === "video" && entry.title ? `${entry.title}\n\n${entry.text || ""}` : entry.text), ...(attachments.length ? { attachments: attachments.join(",") } : {}) };
  // Текст выпускаем ключом сообщества (так работает у нас), с вложениями — ключом администратора.
  let res = await call("wall.post", params, media.length || !community ? user.token : community, { retries: 0 });
  if (res.kind === "refused" && [15, 27, 28].includes(res.code) && user.token && !media.length) res = await call("wall.post", params, user.token, { retries: 0 });
  if (res.kind === "refused" && [15, 27, 28].includes(res.code)) return manual(`ВКонтакте не дал ключу права на запись (код ${res.code}). Нужен ключ администратора с правом wall либо запрос в поддержку ВКонтакте.`);
  if (res.kind !== "ok" || !res.response?.post_id) {
    return { ok: false, retry: res.kind === "network", error: res.code === 214 ? "ВКонтакте: достигнут суточный предел записей на стене" : `запись не принята: ${res.error}` };
  }
  const post = res.response.post_id;
  return { ok: true, id: `-${groupId()}_${post}`, link: `https://vk.com/wall-${groupId()}_${post}` };
}

/** Номер записи из номера публикации или из ссылки: «-123_45». */
export function postRef(item) {
  const direct = String(item.externalId || "").match(/^-?\d+_\d+$/)?.[0];
  return direct || String(item.link || item.externalId || "").match(/wall(-?\d+_\d+)/)?.[1] || "";
}

/** Просмотры, отметки, комментарии, репосты. Читает сервисный ключ; ключ сообщества стену не читает. */
export async function metrics(items) {
  const token = env("VK_SERVICE_TOKEN") || (await userToken()).token;
  if (!token) return items.map((i) => ({ externalId: i.externalId, error: "цифры ВКонтакте читает сервисный ключ приложения (VK_SERVICE_TOKEN) либо ключ администратора", kind: "refused" }));
  const refs = items.map((i) => ({ item: i, ref: postRef(i) }));
  const out = [];
  for (let i = 0; i < refs.length; i += 100) {
    const batch = refs.slice(i, i + 100).filter((x) => x.ref);
    if (!batch.length) continue;
    const r = await call("wall.getById", { posts: batch.map((x) => x.ref).join(",") }, token);
    const list = Array.isArray(r.response) ? r.response : r.response?.items || [];
    const byRef = new Map(list.map((p) => [`${p.owner_id}_${p.id}`, p]));
    for (const { item, ref } of batch) {
      const p = byRef.get(ref);
      if (r.kind !== "ok") out.push({ externalId: item.externalId, error: r.error, kind: r.kind });
      else if (!p) out.push({ externalId: item.externalId, error: "запись не найдена на стене", kind: "refused" });
      else out.push({ externalId: item.externalId, views: Number(p.views?.count) || 0, likes: Number(p.likes?.count) || 0, comments: Number(p.comments?.count) || 0, reposts: Number(p.reposts?.count) || 0 });
    }
    await realSleep(400);
  }
  for (const { item, ref } of refs) if (!ref) out.push({ externalId: item.externalId, error: "нет номера записи: пришлите ссылку ответом на пакет", kind: "refused" });
  return out;
}

async function group() {
  const token = env("VK_GROUP_TOKEN") || env("VK_SERVICE_TOKEN") || (await userToken()).token;
  if (!token) return { kind: "refused", error: "нет ключей ВКонтакте" };
  const r = await call("groups.getById", { group_id: groupId(), fields: "members_count" }, token);
  if (r.kind !== "ok") return r;
  const g = Array.isArray(r.response) ? r.response[0] : r.response?.groups?.[0];
  return g ? { kind: "ok", group: g } : { kind: "refused", error: "сообщество не найдено: проверьте VK_GROUP_ID" };
}

export async function followers() {
  const g = await group();
  return g.kind === "ok" && Number.isFinite(Number(g.group.members_count)) ? Number(g.group.members_count) : null;
}

/** Для doctor: сообщество видно, и понятно, в каком режиме выйдут фото и видео. */
export async function probe() {
  const g = await group();
  if (g.kind !== "ok") return g;
  const user = await userToken();
  const mode = user.token ? "фото и видео загружает ключ администратора" : `фото и видео пойдут пакетом на ручную выкладку${user.error ? ` (${user.error})` : ""}`;
  return { kind: "ok", detail: `сообщество «${g.group.name}», участников ${g.group.members_count ?? "?"}; ${mode}` };
}
