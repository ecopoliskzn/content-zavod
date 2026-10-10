// Разбор лент и страниц: RSS, Atom, веб-витрина Telegram-канала, список ссылок на странице.
// Чистые функции: текст на вход, список записей на выход. Сети здесь нет.
//
// Разбор регулярками, без библиотек: ленты новостей устроены просто, а зависимость
// пришлось бы обновлять и проверять. Запись, которая не разобралась, пропускается: одна
// кривая лента не должна ронять сбор по остальным.

const decode = (s) =>
  String(s ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, " ")
    .trim();

const tag = (block, name) => block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"))?.[1] ?? "";
const iso = (s) => {
  const t = Date.parse(String(s || "").trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
};

/** RSS 2.0: <item><title><link><pubDate><description>. */
export function parseRss(xml) {
  const out = [];
  for (const block of String(xml).split(/<item[\s>]/i).slice(1)) {
    const item = block.split(/<\/item>/i)[0];
    const url = decode(tag(item, "link")) || decode(tag(item, "guid"));
    const title = decode(tag(item, "title"));
    if (!url || !title) continue;
    out.push({ title, url, published: iso(decode(tag(item, "pubDate")) || decode(tag(item, "dc:date"))), summary: decode(tag(item, "description")).slice(0, 600) });
  }
  return out;
}

/** Atom: <entry><title><link href><updated><summary>. */
export function parseAtom(xml) {
  const out = [];
  for (const block of String(xml).split(/<entry[\s>]/i).slice(1)) {
    const entry = block.split(/<\/entry>/i)[0];
    const url = entry.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)?.[1] || entry.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] || "";
    const title = decode(tag(entry, "title"));
    if (!url || !title) continue;
    out.push({ title, url: decode(url), published: iso(decode(tag(entry, "published")) || decode(tag(entry, "updated"))), summary: decode(tag(entry, "summary") || tag(entry, "content")).slice(0, 600) });
  }
  return out;
}

/** Лента любого из двух видов. */
export function parseFeed(xml) {
  return /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml) ? parseAtom(xml) : parseRss(xml);
}

/** Веб-витрина канала t.me/s/<канал>: текст поста, дата, просмотры, ссылка. */
export function parseTelegram(html) {
  const out = [];
  for (const block of String(html).split('<div class="tgme_widget_message_wrap').slice(1)) {
    const post = block.match(/data-post="([^"]+)"/)?.[1];
    if (!post) continue;
    const text = decode(block.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "");
    if (!text) continue;
    const date = block.match(/<time[^>]*datetime="([^"]+)"/)?.[1] ?? "";
    const views = decode(block.match(/tgme_widget_message_views">([^<]+)</)?.[1] ?? "");
    out.push({ title: text.slice(0, 140), url: `https://t.me/${post}`, published: iso(date), summary: text.slice(0, 600), views });
  }
  return out;
}

/**
 * Список ссылок на странице новостей без ленты. pattern — регулярка адреса новости
 * (например "/news/\\d+"): берутся только ссылки, которые под неё подходят.
 */
export function parseLinks(html, baseUrl, pattern) {
  const re = new RegExp(pattern);
  const seen = new Set();
  const out = [];
  for (const m of String(html).matchAll(/<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url;
    try { url = new URL(m[1], baseUrl).toString(); } catch { continue; }
    if (!re.test(url) || seen.has(url)) continue;
    const title = decode(m[2]);
    if (title.length < 20) continue; // «Читать далее», иконки, даты
    seen.add(url);
    out.push({ title: title.slice(0, 200), url, published: "", summary: "" });
  }
  return out;
}

/**
 * Оценка новости по словарю ниши: сумма весов сработавших правил.
 * Правило с полем unless пропускается, если сработало правило с этой меткой: так
 * минус-слова («зимняя резина») не топят новость, в которой есть ядро темы.
 * @param {{ title: string, summary?: string }} item
 * @param {Array<{ re: string, weight: number, tag: string, unless?: string }>} dictionary
 */
export function score(item, dictionary) {
  const text = `${item.title} ${item.summary || ""}`;
  const hit = dictionary.filter((rule) => new RegExp(rule.re, "iu").test(text));
  const tags = [...new Set(hit.map((r) => r.tag).filter(Boolean))];
  let total = 0;
  for (const rule of hit) {
    if (rule.unless && tags.includes(rule.unless)) continue;
    total += rule.weight;
  }
  return { score: total, tags };
}

/** Адрес без меток и хвостов: чтобы одна новость с разными utm не считалась дважды. */
export function canonical(url) {
  try {
    let u = new URL(url);
    // Поиск новостей Bing отдаёт адрес статьи параметром url своей ссылки-счётчика.
    if (/(^|\.)bing\.com$/.test(u.hostname) && u.searchParams.get("url")) {
      try { u = new URL(u.searchParams.get("url")); } catch { /* оставляем как есть */ }
    }
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|from$|ref$|fbclid$|yclid$)/i.test(k)) u.searchParams.delete(k);
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return String(url);
  }
}

/** Текст статьи из HTML: берём самый «плотный» блок статьи и чистим разметку. */
export function articleText(html) {
  const src = String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<!--[\s\S]*?-->/gi, " ");
  const candidates = [
    src.match(/<article[\s\S]*?<\/article>/i)?.[0],
    src.match(/<div[^>]+class=["'][^"']*(?:entry-content|post-content|article-content|blog-content|content__text)[^"']*["'][\s\S]*?<\/div>\s*<\/div>/i)?.[0],
    src.match(/<main[\s\S]*?<\/main>/i)?.[0],
    src.match(/<body[\s\S]*?<\/body>/i)?.[0],
  ].filter(Boolean);
  const block = candidates[0] || src;
  const text = block
    .replace(/<(?:nav|header|footer|form|aside)[\s\S]*?<\/(?:nav|header|footer|form|aside)>/gi, " ")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${"#".repeat(Math.min(Number(n) + 1, 4))} ${decode(t)}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${decode(t)}`)
    .replace(/<\/(?:p|div|tr|ul|ol|table|blockquote)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&laquo;/g, "«").replace(/&raquo;/g, "»").replace(/&mdash;/g, "—").replace(/&ndash;/g, "–")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const title = decode(src.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? src.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  return { title, text };
}

/**
 * Оставляет от текста страницы саму статью: от заголовка до первого «хвостового» блока
 * (форма заявки, выбор города, «читайте также»). Шапка и подвал сайта в материал не идут.
 * @param {string} text  текст из articleText()
 * @param {string} title заголовок статьи
 * @param {string[]} [endMarkers] начала строк, с которых начинается хвост страницы
 * @returns {{ text: string, dateText: string }}
 */
export function trimArticle(text, title, endMarkers = []) {
  const norm = (s) => String(s).toLowerCase().replace(/[«»"'.,:;!?—–-]/g, " ").replace(/\s+/g, " ").trim();
  const lines = String(text).split("\n");
  const wanted = norm(title);
  let start = 0;
  if (wanted) {
    const i = lines.findIndex((l) => /^#{1,4}\s/.test(l) && norm(l.replace(/^#+\s/, "")) === wanted);
    if (i >= 0) start = i + 1;
  }
  const generic = ["Читайте также", "Похожие статьи", "Другие статьи", "Поделиться", "Комментарии", "Оставить комментарий", "Выберите город", "Заказать звонок", "Заполните форму"];
  const markers = [...endMarkers, ...generic].map(norm).filter(Boolean);
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const l = norm(lines[i].replace(/^#+\s/, ""));
    if (l && markers.some((m) => l.startsWith(m))) { end = i; break; }
  }
  let body = lines.slice(start, end);
  // Служебные строки сразу под заголовком: дата, оценка, счётчик просмотров.
  let dateText = "";
  while (body.length) {
    const l = body[0].trim();
    const date = l.match(/^(\d{1,2}\s+\p{L}+\s+\d{4})\s*г?\.?$/u);
    if (date) { dateText = date[1]; body.shift(); continue; }
    if (!l || /^[\d\s.,]+$/.test(l)) { body.shift(); continue; }
    break;
  }
  // Те же служебные строки сайт повторяет под статьёй.
  while (body.length) {
    const l = body[body.length - 1].trim();
    if (!l || /^[\d\s.,]+$/.test(l) || /^\d{1,2}\s+\p{L}+\s+\d{4}\s*г?\.?$/u.test(l)) { body.pop(); continue; }
    break;
  }
  return { text: body.join("\n").replace(/\n{3,}/g, "\n\n").trim(), dateText };
}
