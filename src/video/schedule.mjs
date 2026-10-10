// Срок выхода ролика на YouTube следует за записью очереди.
//
// ЧТО БЫЛО НЕ ТАК. Ролик загружается закрытым с датой выхода, и YouTube открывает его сам:
// так выход не зависит от включённого компьютера и от связи сервера с Google. Но у выпуска
// появились вторые часы, о которых очередь не знала. Утверждающий нажимал «Снять» либо
// «Отозвать согласие», бот отвечал «Не выйдет», запись останавливалась, а YouTube в
// назначенную минуту открывал ролик. То же с командой /stop_release: «ничего не выйдет»
// было правдой для всех площадок, кроме главной.
//
// КАК ТЕПЕРЬ. У каждой записи YouTube с загруженным роликом есть срок, который должен
// стоять на YouTube прямо сейчас:
//   одобрена, слот впереди         → срок равен слоту;
//   всё остальное (ждёт «да», на правке, снята, просрочена, ошибка) → срока нет, ролик закрыт;
//   выпуск остановлен человеком    → срока нет ни у одного ролика.
// Сервер сверяет это с тем, что выставлял сам (extra.youtubePublishAt), и правит разницу.
// Сверка идёт дважды: сразу в обработчике кнопки или команды и на каждом проходе выпуска.
// Второе нужно, потому что первое может не дойти до Google.
//
// КТО СВЕРЯЕТ. Только сервер. Компьютер оператора при перехвате расписания сроки не
// трогает: иначе две машины переставляли бы срок друг за другом. Остановка ради перехвата
// сроки тоже не снимает: сервер уступил расписание, а «ничего не выпускать» никто не говорил.
//
// ЧЕГО ПРОГРАММА НЕ ДЕЛАЕТ. Уже открытый ролик она не закрывает: закрыть опубликованное на
// канале клиента решает человек. Об открытом ролике при снятой записи уходит тревога.
//
// СТАТУС: правка срока написана по документации Data API, боем не проверена. Первая
// проверка стоит в плане запуска: загрузить пробный ролик со сроком, снять запись,
// убедиться в Студии, что срок исчез.

import { alert, h, resolve } from "../lib/notify.mjs";
import { dueAt, mskDate, mskTime } from "../lib/time.mjs";
import * as youtube from "../channels/youtube.mjs";
import { all, get, patch } from "../queue/store.mjs";
import { isTakeover, stopState } from "../queue/switch.mjs";

/** «Не трогать»: срок на YouTube остаётся каким был. */
export const KEEP = null;

let api = youtube;
/** Для тестов: подменить вызовы YouTube; null возвращает настоящие. */
export function _setApi(fake) { api = fake || youtube; }

/**
 * Какой срок выхода должен стоять на YouTube у ролика этой записи. Чистая функция.
 * @returns {string | null} срок в ISO; "" — срока быть не должно; KEEP — не трогать
 */
export function wantedPublishAt(entry, { now = Date.now(), stopped = false } = {}) {
  if (entry?.channel !== "youtube" || !entry.extra?.youtubeId) return KEEP;
  // Вышедший и уже открытый ролик срока не имеет; «выходит» прямо сейчас сверяет выпуск.
  if (entry.status === "published" || entry.status === "running" || entry.extra.youtubeOpen) return KEEP;
  if (entry.status !== "approved" || stopped) return "";
  const due = dueAt(entry);
  // Слот ближе десяти минут: срок уже не переставляем, в слот ролик откроет выпуск.
  return due > now + 10 * 60_000 ? new Date(due).toISOString() : KEEP;
}

const when = (iso) => `${mskDate(Date.parse(iso)).slice(8, 10)}.${mskDate(Date.parse(iso)).slice(5, 7)} в ${mskTime(Date.parse(iso))} по Москве`;
const STUDIO = "Студия YouTube → «Контент» → ролик → «Параметры доступа» → «Ограниченный доступ», без даты";

/**
 * Привести срок одного ролика к состоянию записи.
 * @returns {Promise<{ changed: boolean, want?: string, error?: string, opensAt?: string, open?: boolean, link?: string }>}
 *   opensAt — срок, который остался на ролике после неудачной правки: в эту минуту YouTube откроет его сам
 */
export async function syncOne(entry, { now = Date.now(), stopped } = {}) {
  if (isTakeover()) return { changed: false };
  const halted = stopped ?? (() => { const s = stopState(); return s.stopped && !s.takeover; })();
  const want = wantedPublishAt(entry, { now, stopped: halted });
  const have = entry.extra?.youtubePublishAt || "";
  if (want === KEEP || want === have) return { changed: false };
  const id = entry.extra.youtubeId;
  const link = `https://www.youtube.com/watch?v=${id}`;
  const save = async (fields) => { const fresh = get(entry.id) || entry; await patch(entry.id, { extra: { ...(fresh.extra || {}), ...fields } }, "срок YouTube"); };

  const s = await api.status(id);
  if (s.kind === "ok" && s.privacy === "public") {
    // Опоздали: ролик открыт. Запоминаем, чтобы не стучаться к YouTube на каждом проходе.
    await save({ youtubeOpen: true, youtubePublishAt: "" });
    if (want === "") {
      await alert(`yt-open:${entry.id}`, `Ролик «${h(entry.title || entry.name)}» уже открыт на YouTube, а запись в очереди не одобрена (${h(entry.status === "approved" ? "выпуск остановлен" : entry.status)}).\n${h(link)}`, { action: `если ролик не должен быть виден, закройте его: ${STUDIO}` });
    }
    return { changed: false, open: true, link };
  }
  const done = s.kind === "ok" ? await api.setSchedule(s.raw, want) : { ok: false, error: s.error };
  if (!done.ok) {
    if (want === "" && have) {
      // Опасный случай: согласия нет, а срок на ролике остался. Человеку нужно действие с телефона.
      await alert(`yt-hold:${entry.id}`, `Срок выхода ролика «${h(entry.title || entry.name)}» на YouTube снять не удалось: ${h(done.error || "причина не названа")}.\nYouTube откроет ролик сам ${when(have)}.\n${h(link)}`, { action: `снимите дату руками: ${STUDIO}. Сервер повторит попытку через пять минут` });
    }
    return { changed: false, want, error: done.error || "YouTube не ответил", opensAt: have, link };
  }
  await save({ youtubePublishAt: want });
  resolve(`yt-hold:${entry.id}`);
  return { changed: true, want, link };
}

/**
 * Сверить сроки всех загруженных роликов. Зовёт выпуск на каждом проходе и рубильник.
 * @returns {Promise<{ withdrawn: string[], scheduled: string[], failed: Array<{ name: string, error: string, want: string, opensAt: string }>, open: string[] }>}
 */
export async function syncAll({ now = Date.now(), stopped } = {}) {
  const out = { withdrawn: [], scheduled: [], failed: [], open: [] };
  if (isTakeover()) return out;
  for (const entry of all()) {
    if (entry.channel !== "youtube" || !entry.extra?.youtubeId) continue;
    const r = await syncOne(entry, { now, stopped });
    if (r.open) out.open.push(entry.name);
    else if (r.error) out.failed.push({ name: entry.name, error: r.error, want: r.want, opensAt: r.opensAt || "" });
    else if (r.changed) (r.want ? out.scheduled : out.withdrawn).push(entry.name);
  }
  return out;
}

/** Одна строка для человека о том, что стало со сроком ролика. Пустая, если сказать нечего. */
export function sayOne(r) {
  if (!r) return "";
  if (r.open) return `Ролик уже открыт на YouTube: ${r.link}. Закрыть его может только человек: ${STUDIO}.`;
  if (r.error && r.want === "") return `Срок выхода на YouTube снять не удалось (${r.error}). Ролик откроется сам ${when(r.opensAt)}. Снимите дату руками: ${STUDIO}.`;
  if (r.error) return r.opensAt ? `Срок выхода на YouTube переставить не удалось (${r.error}): на ролике остался прежний срок, ${when(r.opensAt)}.` : `Срок выхода на YouTube поставить не удалось (${r.error}): в слот ролик откроет сервер.`;
  if (!r.changed) return "";
  return r.want ? `Срок выхода ролика на YouTube: ${when(r.want)}.` : "Срок выхода на YouTube снят: ролик остаётся закрытым.";
}

/** То же для сверки всех роликов разом: рубильник и возврат выпуска. */
export function sayAll(r) {
  const rows = [];
  if (r.withdrawn.length) rows.push(`Срок выхода на YouTube снят у роликов: ${r.withdrawn.length}. Они остаются закрытыми.`);
  if (r.scheduled.length) rows.push(`Срок выхода на YouTube поставлен роликам: ${r.scheduled.length}.`);
  for (const f of r.failed) rows.push(f.want === "" ? `Срок у ролика «${f.name}» снять не удалось (${f.error}): YouTube откроет его сам ${when(f.opensAt)}. Снимите дату руками: ${STUDIO}.` : `Срок у ролика «${f.name}» не поставлен (${f.error})${f.opensAt ? `: остался прежний, ${when(f.opensAt)}` : ": в слот ролик откроет сервер"}.`);
  if (r.open.length) rows.push(`Уже открыты на YouTube: ${r.open.join(", ")}.`);
  return rows.join("\n");
}

/**
 * Сверка после действия над записью: не роняет действие, если Google недоступен.
 * @returns {Promise<string>} строка для человека либо пустая
 */
export async function afterChange(id) {
  try {
    const entry = get(id);
    if (!entry || entry.channel !== "youtube" || !entry.extra?.youtubeId) return "";
    return sayOne(await syncOne(entry));
  } catch (e) {
    console.error("[срок YouTube] сверка не прошла:", e?.message || e);
    return "Срок выхода на YouTube сверить не удалось: сервер повторит попытку через пять минут.";
  }
}
