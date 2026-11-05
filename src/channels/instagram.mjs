// Instagram: рилс, карусель, история. Публикация в две ступени: контейнер, потом выпуск.
//
// СТАТУС: ответы по кодовым словам через это же API у нас работают в двух проектах.
// ПУБЛИКАЦИЮ своим кодом мы раньше делали через посредника, поэтому этот файл написан по
// официальной документации (сверено 10.10.2026) и ОБЯЗАН пройти живую проверку в первой
// же сессии: один рилс до конца, со ссылкой на вышедший пост.
//
// Что известно точно (документация и наш опыт):
//  · API работает только с профессиональным аккаунтом (компания или автор). Личный не
//    подключить вообще: это первое, что проверяем;
//  · файл Meta забирает сама по публичному адресу. С российских сайтов она его не берёт,
//    из публичного объектного хранилища берёт: у нас проходило с первой попытки;
//  · требования к видео: MP4 или MOV, H.264 или HEVC, звук AAC, ширина ДО 1920, длина
//    от 3 секунд до 15 минут, до 300 МБ. Исходник с телефона 2160×3840 не пройдёт: под
//    Instagram готовится копия 1080×1920;
//  · статус контейнера опрашивается: IN_PROGRESS → FINISHED (или ERROR, EXPIRED).
//    Документация советует не чаще раза в минуту и не дольше пяти минут;
//  · контейнер живёт сутки. Оборвались после создания — продолжаем с того же контейнера;
//  · подпись ОКОНЧАТЕЛЬНАЯ: изменить подпись вышедшего поста API не умеет, только руками
//    в приложении. Поэтому подпись согласуется до выпуска и проверяется дважды;
//  · суточный предел публикаций отдаёт сама площадка (content_publishing_limit): в
//    документации стоит и 50, и 100, верить ответу API;
//  · ссылки в комментариях не нажимаются, ссылку в историю API не ставит. Призыв в
//    истории рисуется в саму картинку.

import { env } from "../lib/env.mjs";
import { ig, igUserId } from "../lib/ig.mjs";
import { sleep as realSleep } from "../lib/http.mjs";

export const name = "instagram";

const fail = (r, what) => ({ ok: false, error: `${what}: ${r.error}`, retry: r.kind === "network" });

async function waitReady(containerId, sleep) {
  // До десяти минут с шагом в полминуты: длинный ролик площадка обрабатывает не сразу.
  for (let i = 0; i < 20; i++) {
    const r = await ig(`${containerId}?fields=status_code,status`, { retries: 0 });
    const code = r.data?.status_code;
    if (code === "FINISHED" || code === "PUBLISHED") return { ok: true, code };
    if (code === "ERROR" || code === "EXPIRED") return { ok: false, error: `контейнер в статусе ${code}${r.data?.status ? `: ${r.data.status}` : ""}`, retry: code === "EXPIRED" };
    await sleep(30_000);
  }
  return { ok: false, error: "площадка обрабатывает файл дольше десяти минут", retry: true };
}

async function createContainer(body) {
  const r = await ig(`${igUserId()}/media`, { method: "POST", body, timeoutMs: 60_000 });
  return r.kind === "ok" && r.data?.id ? { id: r.data.id } : fail(r, "контейнер не создан");
}

// Изображения Instagram API передаются в JPEG. Проверяем реальный ответ, а не расширение.
async function imageReady(url){
  try{
    const r=await fetch(url,{headers:{range:'bytes=0-1023'},signal:AbortSignal.timeout(20000)});
    if(!r.ok)return {ok:false,retry:true,error:`изображение недоступно (HTTP ${r.status})`};
    const reader=r.body.getReader();let prefix=new Uint8Array();
    try{while(prefix.length<3){const part=await reader.read();if(part.done)break;const joined=new Uint8Array(prefix.length+Math.min(3-prefix.length,part.value.length));joined.set(prefix);joined.set(part.value.subarray(0,3-prefix.length),prefix.length);prefix=joined;}}finally{await reader.cancel();}
    const type=(r.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    if(type!=='image/jpeg'||prefix[0]!==255||prefix[1]!==216||prefix[2]!==255)return {ok:false,retry:false,error:'Instagram: нужна отдельная публикационная версия JPEG; PNG/WebP не отправляются в контейнер'};
    const total=Number(r.headers.get('content-range')?.split('/').at(-1)||r.headers.get('content-length'));
    if(total>8*1024*1024)return {ok:false,retry:false,error:'Instagram: JPEG превышает 8 МБ'};
    return {ok:true};
  }catch{return {ok:false,retry:true,error:'изображение не проверено: сеть или некорректный ответ хранилища'};}
}

/**
 * @param {{ kind: string, text?: string, media: Array<{type:string,url:string,cover?:string}>, result?: { containerId?: string } }} entry
 * @param {{ onStep?: Function, sleep?: Function }} ctx
 */
export async function publish(entry, ctx = {}) {
  const sleep = ctx.sleep || realSleep;
  if (!igUserId()) return { ok: false, error: "нет IG_USER_ID", retry: false };
  const media = entry.media || [];
  let containerId = entry.result?.containerId || "";

  if (!containerId) {
    // Все кадры проверяются до первого создания: ошибка позднего кадра не оставляет
    // ненужные дочерние контейнеры. Существующий контейнер повторно не создаётся.
    for(const m of media.filter(m=>m.type==='image')){const ready=await imageReady(m.url);if(!ready.ok)return ready;}
    let created;
    if (entry.kind === "reel") {
      const video = media.find((m) => m.type === "video");
      created = await createContainer({ media_type: "REELS", video_url: video.url, caption: entry.text || "", share_to_feed: true, ...(video.cover ? { cover_url: video.cover } : {}) });
    } else if (entry.kind === "story") {
      const m = media[0];
      created = await createContainer({ media_type: "STORIES", ...(m.type === "video" ? { video_url: m.url } : { image_url: m.url }) });
    } else if (entry.kind === "carousel") {
      // Прямое создание карусели одним вызовом площадка у нас дважды отвергла.
      // Рабочий путь: отдельный контейнер на каждый слайд, затем контейнер карусели.
      const children = [];
      for (const m of media.filter((x) => x.type === "image").slice(0, 10)) {
        const child = await createContainer({ image_url: m.url, is_carousel_item: true });
        if (!child.id) return child;
        children.push(child.id);
        await sleep(1_500);
      }
      created = await createContainer({ media_type: "CAROUSEL", children: children.join(","), caption: entry.text || "" });
    } else {
      return { ok: false, error: `вид «${entry.kind}» в Instagram не выпускается`, retry: false };
    }
    if (!created.id) return created;
    containerId = created.id;
    // Номер контейнера сохраняем сразу: повтор после обрыва не создаст второй.
    if (ctx.onState) await ctx.onState({ containerId });
  }

  const ready = await waitReady(containerId, sleep);
  if (!ready.ok) return { ...ready, containerId };

  let mediaId = "";
  if (ready.code !== "PUBLISHED") {
    const pub = await ig(`${igUserId()}/media_publish`, { method: "POST", body: { creation_id: containerId }, timeoutMs: 60_000, retries: 0 });
    if (!(pub.kind === "ok" && pub.data?.id)) {
      // Ошибка выпуска ещё не значит, что пост не вышел: смотрим статус контейнера.
      await sleep(15_000);
      const again = await ig(`${containerId}?fields=status_code`, { retries: 0 });
      if (again.data?.status_code !== "PUBLISHED") return { ...fail(pub, "выпуск не прошёл"), containerId };
    } else {
      mediaId = pub.data.id;
    }
  }
  if (!mediaId) {
    // Контейнер уже выпущен прошлым проходом: находим пост среди последних в ленте.
    const feed = await ig(`${igUserId()}/media?fields=id,permalink,caption&limit=5`, { retries: 1 });
    const mine = (feed.data?.data || []).find((p) => (p.caption || "").startsWith((entry.text || "").slice(0, 40)));
    mediaId = mine?.id || "";
    if (mine?.permalink) return { ok: true, id: mediaId, link: mine.permalink };
  }
  const link = mediaId ? (await ig(`${mediaId}?fields=permalink`, { retries: 1 })).data?.permalink || "" : "";
  return { ok: true, id: mediaId, link };
}

/**
 * Цифры публикаций. Главный счётчик — views; plays и impressions площадка упразднила.
 * Данные приходят с задержкой до двух суток.
 */
export async function metrics(items) {
  const out = [];
  for (const item of items) {
    const r = await ig(`${item.externalId}/insights?metric=views,reach,likes,comments,saved,shares,total_interactions,ig_reels_avg_watch_time`, { retries: 1 });
    if (r.kind !== "ok") { out.push({ externalId: item.externalId, error: r.error, kind: r.kind }); continue; }
    const row = { externalId: item.externalId };
    for (const m of r.data?.data || []) row[m.name === "saved" ? "saves" : m.name === "ig_reels_avg_watch_time" ? "avgWatchMs" : m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
    out.push(row);
    await realSleep(500);
  }
  return out;
}

/** Подписчики аккаунта: для недельного отчёта. */
export async function followers() {
  const r = await ig("me?fields=followers_count", { retries: 1 });
  const count = Number(r.data?.followers_count);
  return r.kind === "ok" && Number.isFinite(count) ? count : null;
}

/** Проверка для doctor: маркер жив, аккаунт профессиональный, предел публикаций не выбран. */
export async function probe() {
  const me = await ig("me?fields=user_id,username,account_type");
  if (me.kind !== "ok") return me;
  const limit = await ig(`${igUserId() || me.data.user_id}/content_publishing_limit?fields=quota_usage,config`);
  const used = limit.data?.data?.[0]?.quota_usage;
  const total = limit.data?.data?.[0]?.config?.quota_total;
  return { kind: "ok", detail: `@${me.data.username}, тип ${me.data.account_type || "?"}${total ? `, публикаций за сутки ${used} из ${total}` : ""}` };
}

/** Продление маркера: ему должно быть больше суток, и он не должен истечь. */
export async function refreshToken() {
  const r = await ig("refresh_access_token?grant_type=ig_refresh_token", { retries: 1 });
  if (r.kind !== "ok" || !r.data?.access_token) return { kind: r.kind === "ok" ? "refused" : r.kind, error: r.error || "площадка не вернула новый маркер" };
  return { kind: "ok", token: r.data.access_token, expiresInSec: Number(r.data.expires_in) || 0 };
}

/**
 * Подписка аккаунта на события. Отдельный вызов; повторяется после каждого продления маркера.
 *
 * ТОЛЬКО НА СВОЁМ ПРИЛОЖЕНИИ META. События приходят на адрес приложения, которому выдан
 * маркер. Первый месяц это приложение исполнителя: подписка отправила бы комментарии и
 * сообщения людей на его сервер. Компания ведёт завод сама, и посторонний сервер в этой
 * цепочке не нужен. Поэтому, пока своего приложения нет (в окружении нет IG_APP_SECRET),
 * подписка не оформляется, а кодовые слова под публикациями читает опрос (IG_POLL=1).
 */
export async function subscribe() {
  if (!env("IG_APP_SECRET")) return { kind: "skipped", error: "своего приложения Meta ещё нет: события не подключаются, комментарии читает опрос (IG_POLL=1)" };
  return ig("me/subscribed_apps?subscribed_fields=comments,messages", { method: "POST", body: {} });
}
