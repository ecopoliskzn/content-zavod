// Серии роликов и сборка описания. Чистые функции: реестр и запись на вход, текст на выход.
//
// ЗАЧЕМ СЕРИИ. Короткий ролик зритель досматривает и уходит: конечных заставок и
// подсказок у коротких роликов нет. Дальше его ведут три вещи: плейлист серии, ссылки
// на соседние ролики в описании и закреплённый комментарий. У нас 73 ролика из 82 лежали
// вне серий, а три самых просматриваемых ролика об одном человеке не были связаны ничем.
//
// КАК УСТРОЕНО ОПИСАНИЕ. Человек клиента согласует ТЕКСТ: первую строку, суть, анонс
// следующей части. Блок ссылок под текстом собирается программой из реестра серий:
// плейлист, соседние части, статья сайта, «смотрите также». Поэтому, когда выходит новая
// часть, описание прошлой дополняется ссылкой на неё без повторного согласования:
// согласованный текст не изменился.
//
// Реестр серий: content/youtube/series.json. Два вида серий:
//   order "parts" — история по частям: порядок как в реестре, есть «следующая» и «предыдущая»;
//   order "views" — самостоятельные ролики одной темы: в плейлисте первым стоит самый
//                   просматриваемый, потому что плейлист открывают с первого ролика.

export const watchUrl = (id) => `https://youtu.be/${id}`;
export const playlistUrl = (id) => `https://www.youtube.com/playlist?list=${id}`;

const PLATFORM = { youtube: "yt", rutube: "rt", vk: "vk", instagram: "ig" };

/** Серия и место ролика в ней: по номеру ролика либо по имени записи очереди. */
export function locate(registry, { videoId = "", name = "", series = "" } = {}) {
  for (const s of registry?.series || []) {
    if (series && s.key !== series) continue;
    const index = (s.videos || []).findIndex((v) => (videoId && v.id === videoId) || (name && v.name === name));
    if (index >= 0) return { series: s, index, video: s.videos[index] };
  }
  const direct = series ? (registry?.series || []).find((s) => s.key === series) : null;
  return direct ? { series: direct, index: -1, video: null } : null;
}

/** Соседи ролика. У серии по частям — прошлая и следующая; у тематической — два лучших других. */
export function neighbours(registry, where) {
  const found = locate(registry, where);
  if (!found) return { series: null, prev: null, next: null, also: [] };
  const { series, index } = found;
  const published = (series.videos || []).filter((v) => v.id);
  if (series.order === "parts") {
    const prev = index > 0 ? series.videos.slice(0, index).reverse().find((v) => v.id) || null : null;
    const next = index >= 0 ? series.videos.slice(index + 1).find((v) => v.id) || null : null;
    return { series, prev, next, also: [] };
  }
  const self = found.video?.id;
  return { series, prev: null, next: null, also: published.filter((v) => v.id !== self).slice(0, 2) };
}

/** Хэштеги строкой: не больше пяти, без пробелов внутри. */
export function hashtags(list) {
  return (list || []).map((h) => `#${String(h).replace(/^#/, "").replace(/[\s#]+/g, "")}`).filter((h) => h.length > 1).slice(0, 5).join(" ");
}

/**
 * Полное описание ролика: согласованный текст и блок ссылок под ним.
 * @param {object} entry запись очереди: text, name, hashtags, goSlug, goLabel, botKey, botLabel, article, series, seeAlso
 * @param {{ registry?: object, videoId?: string, platform?: string, base?: string, bot?: string, about?: string, links?: Record<string,{title?:string}>, titles?: Record<string,string> }} ctx
 */
export function composeDescription(entry, ctx = {}) {
  const platform = ctx.platform || entry.channel || "youtube";
  const mark = PLATFORM[platform] || platform;
  const base = String(ctx.base || "").replace(/\/+$/, "");
  const go = (slug) => (base && slug ? `${base}/go/${slug}?c=${mark}&p=${encodeURIComponent(entry.name || "")}` : "");
  const blocks = [String(entry.text || "").trim()];

  const offer = [];
  if (ctx.about) offer.push(ctx.about);
  if (entry.goSlug && go(entry.goSlug)) offer.push(`${entry.goLabel || ctx.links?.[entry.goSlug]?.title || "Материал к ролику"}: ${go(entry.goSlug)}`);
  if (entry.botKey && ctx.bot) offer.push(`${entry.botLabel || "Материал в Telegram"}: https://t.me/${ctx.bot}?start=${mark}-${entry.botKey}`);
  if (offer.length) blocks.push(offer.join("\n"));

  const tags = hashtags(entry.hashtags);
  if (tags) blocks.push(tags);

  // Связи между роликами есть только у YouTube: это его номера и его плейлисты.
  if (platform === "youtube") {
    const rel = relations(entry, ctx);
    if (rel.length) blocks.push(rel.join("\n"));
  } else if (entry.article && go(entry.article)) {
    blocks.push(`Статья на сайте: ${go(entry.article)}`);
  }
  return blocks.filter(Boolean).join("\n\n");
}

/** Первые слова строк блока связей: по ним блок находится в уже вышедшем описании. */
const RELATION_START = /^(?:Серия «|Следующая часть: |Предыдущая часть: |Статья на сайте: |Смотрите также: )/;

/**
 * Блок связей ролика: плейлист серии, соседние части, статья сайта, «смотрите также».
 * @param {{ name?: string, series?: string, article?: string, seeAlso?: string[] }} entry
 */
export function relations(entry, ctx = {}) {
  const base = String(ctx.base || "").replace(/\/+$/, "");
  const titleOf = (v) => v?.title || ctx.titles?.[v?.id] || "";
  const n = neighbours(ctx.registry, { videoId: ctx.videoId, name: entry.name, series: entry.series });
  const rel = [];
  if (n.series?.playlistId) rel.push(`Серия «${n.series.title}»: ${playlistUrl(n.series.playlistId)}`);
  if (n.next) rel.push(`Следующая часть: ${watchUrl(n.next.id)}${titleOf(n.next) ? ` | ${titleOf(n.next)}` : ""}`);
  if (n.prev) rel.push(`Предыдущая часть: ${watchUrl(n.prev.id)}${titleOf(n.prev) ? ` | ${titleOf(n.prev)}` : ""}`);
  if (entry.article && base) rel.push(`Статья на сайте: ${base}/go/${entry.article}?c=yt&p=${encodeURIComponent(entry.name || "")}`);
  const also = (entry.seeAlso?.length ? entry.seeAlso.map((id) => ({ id })) : n.also).filter((v) => v.id && v.id !== ctx.videoId).slice(0, 2);
  for (const v of also) rel.push(`Смотрите также: ${watchUrl(v.id)}${titleOf(v) ? ` | ${titleOf(v)}` : ""}`);
  return rel;
}

/**
 * Заменить блок связей в готовом описании, не трогая остальной текст. Нужно старым
 * роликам канала: их описания писались без завода, а в серию их включить хочется.
 * Блок связей всегда стоит последним: всё от его первой строки до конца заменяется.
 */
export function replaceRelations(description, rel) {
  const lines = String(description || "").replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) => RELATION_START.test(l));
  const head = (start >= 0 ? lines.slice(0, start) : lines).join("\n").replace(/\s+$/, "");
  return rel.length ? `${head}\n\n${rel.join("\n")}` : head;
}

/** Текст закреплённого комментария: та же ссылка, что в описании, и приглашение спросить. */
export function pinnedComment(entry, ctx = {}) {
  const mark = PLATFORM[ctx.platform || entry.channel || "youtube"] || "yt";
  const base = String(ctx.base || "").replace(/\/+$/, "");
  const link = entry.goSlug && base ? `${base}/go/${entry.goSlug}?c=${mark}&p=${encodeURIComponent(entry.name || "")}` : entry.botKey && ctx.bot ? `https://t.me/${ctx.bot}?start=${mark}-${entry.botKey}` : "";
  const label = entry.goLabel || ctx.links?.[entry.goSlug]?.title || entry.botLabel || "Материал к ролику";
  return [link ? `${label}: ${link}` : "", "Вопросы по своей площадке задавайте здесь: отвечает специалист."].filter(Boolean).join("\n");
}

/** Порядок серии «по просмотрам»: лучший первым. Чистая функция для реестра и плейлиста. */
export function sortByViews(videos, viewsById) {
  return [...videos].sort((a, b) => (viewsById.get(b.id) || 0) - (viewsById.get(a.id) || 0));
}

/** Добавить ролик в серию реестра (или обновить его строку). Возвращает новый реестр. */
export function withVideo(registry, seriesKey, video) {
  const next = { ...registry, series: (registry.series || []).map((s) => ({ ...s, videos: [...(s.videos || [])] })) };
  const s = next.series.find((x) => x.key === seriesKey);
  if (!s) throw Object.assign(new Error(`серии «${seriesKey}» нет в реестре content/youtube/series.json`), { code: "RULE" });
  const i = s.videos.findIndex((v) => (video.name && v.name === video.name) || (video.id && v.id === video.id));
  if (i >= 0) s.videos[i] = { ...s.videos[i], ...video };
  else s.videos.push(video);
  return next;
}
