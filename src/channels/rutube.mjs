// Rutube: ролик по адресу файла либо пакет на ручную выкладку.
//
// СТАТУС: БОЕМ НЕ ПРОВЕРЕНО. Открытой документации API у Rutube на 10.10.2026 нет:
// страница для разработчиков отдаёт 404, поддержка отвечает, что документацию высылают
// по запросу на help@rutube.ru. Адреса и поля ниже взяты из официального клиента Rutube
// (github.com/rutube/php-api-client, в архиве с 2021 года). Сами адреса на сервере
// отвечают, но пустит ли Rutube загрузку с обычного канала, не подтверждено никем.
//
// Поэтому у адаптера два режима, и первый работает с первого дня:
//   · ключа нет (RUTUBE_TOKEN пуст) — в рабочую группу уходит пакет: файл, название,
//     описание, время. Сотрудник загружает ролик в студии Rutube и присылает ссылку;
//   · ключ есть — ролик уходит вызовом POST /api/video/ с адресом файла в хранилище,
//     Rutube забирает его сам. Этот режим включается после письма в поддержку Rutube
//     и первой удачной загрузки под присмотром.
//
// Что известно точно (проверено запросами без ключа):
//  · просмотры и комментарии отдаются открытым JSON: GET /api/video/<id>/ → поле hits.
//    Цифры поэтому снимаются при любом режиме выкладки, нужна только ссылка на ролик;
//  · вертикальный ролик от 2 секунд до 3 минут площадка сама относит к Shorts, отдельного
//    признака нет. Файл до 25 ГБ и до 5 часов;
//  · ключ выдаётся по логину и паролю аккаунта (POST /api/accounts/token_auth/). Пароль
//    вводит владелец аккаунта сам: npm run rutube -- --login. Завод хранит только ключ.

import { env } from "../lib/env.mjs";
import { json, request, sleep as realSleep } from "../lib/http.mjs";
import { describe } from "../video/describe.mjs";
import { sendPackage } from "./manual.mjs";

export const name = "rutube";
const API = "https://rutube.ru/api";

const auth = () => ({ authorization: `Token ${env("RUTUBE_TOKEN")}`, accept: "application/json" });

/** Номер ролика из ссылки: rutube.ru/video/<id>/ или rutube.ru/shorts/<id>/. */
export function idFromLink(link) {
  return String(link || "").match(/rutube\.ru\/(?:video|shorts)\/(?:private\/)?([0-9a-f]{32})/i)?.[1] || "";
}

/** Сведения о ролике без ключа. */
export async function info(id) {
  const r = await request(`${API}/video/${id}/`, { headers: { accept: "application/json" }, retries: 1 });
  if (r.kind !== "ok") return { kind: r.kind, error: r.error };
  return { kind: "ok", hits: Number(r.data?.hits) || 0, hidden: Boolean(r.data?.is_hidden), deleted: Boolean(r.data?.is_deleted), url: r.data?.video_url || `https://rutube.ru/video/${id}/`, reason: r.data?.action_reason || "" };
}

/**
 * @param {{ title: string, text?: string, media: Array<{type:string,url:string,cover?:string}>, result?: { rutubeId?: string } }} entry
 */
export async function publish(entry, ctx = {}) {
  const sleep = ctx.sleep || realSleep;
  const video = (entry.media || []).find((m) => m.type === "video");
  if (!video) return { ok: false, retry: false, error: "в записи нет ролика" };
  // Описание то же, что уйдёт на YouTube: согласованный текст и блок ссылок с меткой площадки.
  const description = describe(entry);

  if (!env("RUTUBE_TOKEN")) {
    return sendPackage({ ...entry, text: description }, {
      onState: ctx.onState,
      why: "Ключа Rutube у завода пока нет: ролик загружает человек.",
      steps: [
        "Скачайте ролик по ссылке ниже на компьютер.",
        "Откройте студию Rutube: studio.rutube.ru и нажмите «Добавить → Загрузить видео».",
        "Выберите файл, вставьте название и описание из следующего сообщения.",
        "Категория: «Бизнес и предпринимательство» либо «Обучение». Доступ: «Для всех». Нажмите «Опубликовать».",
        "Вернитесь сюда: нажмите «Выложено» и ответьте на это сообщение ссылкой на ролик. По ссылке завод сам снимет просмотры.",
      ],
    });
  }

  let id = entry.result?.rutubeId || "";
  if (!id) {
    const created = await request(`${API}/video/`, {
      ...json({ url: video.url, title: entry.title, description, is_hidden: false, category_id: Number(env("RUTUBE_CATEGORY", "67")) }, auth()),
      timeoutMs: 60_000,
    });
    if (created.kind !== "ok") {
      const denied = created.status === 401 || created.status === 403;
      return { ok: false, retry: created.kind === "network", error: denied ? `Rutube не пустил загрузку (${created.status}): ключ отозван либо каналу не открыт доступ к API. Письмо в help@rutube.ru; до ответа уберите RUTUBE_TOKEN, и ролики пойдут пакетом` : `Rutube не принял ролик: ${created.error}` };
    }
    id = String(created.data?.video_id || created.data?.id || "");
    if (!id) return { ok: false, retry: false, error: `Rutube ответил без номера ролика: ${JSON.stringify(created.data).slice(0, 200)}` };
    // Номер сохраняем сразу: повтор после обрыва не загрузит ролик второй раз.
    if (ctx.onState) await ctx.onState({ rutubeId: id });
  }

  // Какое поле означает «обработан», в известных источниках не описано. Считаем ролик
  // вышедшим, когда он виден без ключа и не скрыт.
  for (let i = 0; i < 20; i++) {
    const s = await info(id);
    if (s.kind === "ok" && !s.hidden && !s.deleted) return { ok: true, id, link: s.url || `https://rutube.ru/video/${id}/` };
    if (s.kind === "ok" && s.deleted) return { ok: false, retry: false, error: `Rutube удалил ролик${s.reason ? `: ${s.reason}` : ""}` };
    await sleep(30_000);
  }
  return { ok: false, retry: true, error: "Rutube обрабатывает ролик дольше десяти минут; следующий проход проверит ещё раз, второй загрузки не будет" };
}

/** Просмотры: открытый JSON, ключ не нужен. Номер берётся из номера публикации либо из ссылки. */
export async function metrics(items) {
  const out = [];
  for (const item of items) {
    const id = /^[0-9a-f]{32}$/i.test(String(item.externalId)) ? item.externalId : idFromLink(item.link);
    if (!id) { out.push({ externalId: item.externalId, error: "нет номера ролика: пришлите ссылку ответом на пакет", kind: "refused" }); continue; }
    const s = await info(id);
    if (s.kind !== "ok") { out.push({ externalId: item.externalId, error: s.error, kind: s.kind }); continue; }
    const c = await request(`${API}/comments/video/${id}/`, { headers: { accept: "application/json" }, retries: 0 });
    out.push({ externalId: item.externalId, views: s.hits, ...(c.kind === "ok" && Number.isFinite(Number(c.data?.comments_count)) ? { comments: Number(c.data.comments_count) } : {}) });
    await realSleep(400);
  }
  return out;
}

/** Для doctor. Живую проверку ключа даёт только первая загрузка: открытого метода «кто я» нет. */
export async function probe() {
  if (!env("RUTUBE_TOKEN")) return { kind: "ok", detail: "ключа нет: ролики выходят пакетом на ручную загрузку" };
  const r = await request(`${API}/video/category/`, { headers: auth(), retries: 1 });
  if (r.kind !== "ok") return r;
  return { kind: "ok", detail: "ключ задан, Rutube отвечает. Право загрузки проверяется первым роликом" };
}
