// Метки площадок в ссылках. Чистый модуль: без файлов и сети.
//
// Одна таблица на всё, что строит и читает ссылки: счётчик переходов /go, вход в бота
// (?start=<метка>-<ключ>), проверки перед выходом и команду npm run link. По метке завод
// узнаёт, какая площадка привела человека. Перепутанная метка не ломает ничего, кроме
// главного: заявка запишется не той площадке, и отчёт начнёт врать.

/** Площадка очереди → короткая метка в ссылке. */
export const MARK = { threads: "th", telegram: "tg", vk: "vk", dzen: "dz", youtube: "yt", rutube: "rt", instagram: "ig", bot: "bot" };

/** Имя записи как метка публикации: счётчик принимает латиницу, цифры, дефис и подчёркивание, до 32 знаков. */
export const postMark = (name) => String(name || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 32);

/** Ссылка через счётчик переходов. */
export function goLink(base, slug, channel, name = "") {
  const root = String(base || "").replace(/\/+$/, "");
  const p = postMark(name);
  return `${root}/go/${slug}?c=${MARK[channel] || channel}${p ? `&p=${p}` : ""}`;
}

/** Ссылка в бота с меткой площадки: бот выдаст материал и запомнит, откуда пришёл человек. */
export const botLink = (botUsername, channel, key) => `https://t.me/${String(botUsername || "").replace(/^@/, "")}?start=${MARK[channel] || channel}-${key}`;

/** Ссылки счётчика, найденные в тексте: слаг и метки. */
export function goLinksIn(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/\/go\/([a-z0-9_-]+)(?:\?([^\s"'<>)]*))?/gi)) {
    const q = new URLSearchParams(m[2] || "");
    out.push({ slug: m[1].toLowerCase(), c: q.get("c") || "", p: q.get("p") || "", raw: m[0] });
  }
  return out;
}
