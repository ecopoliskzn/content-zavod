// Проверки текста перед выходом. Чистые функции: текст на вход, претензии на выход.
//
// ЧЕТЫРЕ ПРОВЕРКИ НА ДВУХ ПОСТАХ. При постановке на согласование работают все четыре:
// рядом оператор, он поправит. Перед самым выпуском останавливают только готовность и
// реклама. Одной заставы на входе мало: у нас каркас с заглушкой однажды уехал в живой
// канал уже одобренным. А речь и факты на выпуске не останавливают: человек клиента их
// уже видел в карточке и сказал «да», и снимать одобренное новой придиркой нельзя.
//
//   готовность — текст дописан, а не оставлен каркасом;
//   речь       — нет штампов, счётчиков, повтора прошлых заходов;
//   реклама    — на площадках с ограниченным доступом нет цен, акций и призывов купить;
//   факты      — у каждой цифры в тексте есть источник.
//
// block останавливает запись. warn — повод перечитать: решает человек, который
// согласует. Правило добавляется только с примером текста, на котором оно сработало:
// проверка, которая ругается зря, за неделю приучает не читать её вывод.
//
// ГРАНИЦЫ СЛОВ. `\b` в JavaScript не видит кириллицу: проверки с ним у нас месяц молча
// не работали. Границы считаются через \p{L} и флаг u.

import { POST_LIMIT } from "../queue/format.mjs";

const B = "(?<!\\p{L})"; // левая граница слова
const E = "(?!\\p{L})"; // правая граница слова
const re = (body, flags = "iu") => new RegExp(`${B}(?:${body})${E}`, flags);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Части текста записи: реплики ветки либо заголовок и текст. */
export function partsOf(entry) {
  if (entry.kind === "thread") return entry.posts || [];
  return [entry.title, entry.text].filter(Boolean);
}
const whole = (entry) => partsOf(entry).join("\n\n");
const firstPart = (entry) => partsOf(entry)[0] || "";

/** Начало текста для сверки повторов: 40 знаков без регистра и лишних пробелов. */
export const opener = (text) => String(text || "").replace(/\s+/g, " ").trim().slice(0, 40).toLowerCase();

/* ── 1. Готовность ─────────────────────────────────────────────────────────── */

const PLACEHOLDER = /\[(?:здесь|тут|вставить|ваш|текст|todo)[^\]]*\]|\{\{[^}]*\}\}|\{(?:PL|URL\d?|ССЫЛКА|ссылка|ИМЯ|имя)\}|(?<!\p{L})(?:TODO|FIXME|ХХХ|XXX|lorem ipsum|рыба текста)(?!\p{L})/iu;
// Заглушка в угловых скобках ловится только прописными («<ССЫЛКА>»): строчные теги
// вроде <b> и <blockquote> — это разметка Телеграма, а не недописанный текст.
const ANGLE_PLACEHOLDER = /<[A-ZА-ЯЁ_ ]{3,}>/u;

export function ready(entry) {
  const block = [];
  const text = whole(entry);
  if (!text.trim()) block.push("готовность: текста нет");
  const m = text.match(PLACEHOLDER) || text.match(ANGLE_PLACEHOLDER);
  if (m) block.push(`готовность: в тексте осталась заглушка «${m[0]}»`);
  if (/(?<!\d)1\/[2-9]\s*$/m.test(text)) block.push("готовность: счётчик «1/5» в конце реплики. Ветку и так видно, счётчик читается как конвейер");
  if (entry.kind === "thread") {
    const posts = entry.posts || [];
    const links = text.match(/https?:\/\/\S+/g) || [];
    if (links.length > 1) block.push(`готовность: ссылок ${links.length}, в ветке допустима одна`);
    if (links.length === 1 && !/https?:\/\//.test(posts[posts.length - 1] || "")) block.push("готовность: ссылка стоит не в последней реплике. Ссылка в начале режет охват всей ветки");
    posts.forEach((p, i) => { if (p.length > POST_LIMIT) block.push(`готовность: реплика ${i + 1} длиннее ${POST_LIMIT} знаков`); });
  }
  return { block, warn: [] };
}

/* ── 2. Речь ───────────────────────────────────────────────────────────────── */

const PARALLEL = /(?<!\p{L})не\s+[^,.!?;:\n]{2,40},\s+а\s+/giu;
const LONG_DASH = /\s—\s/g;
const HASHTAG = /(^|\s)#[\p{L}\d_]+/u;
const EMOJI = /\p{Extended_Pictographic}/u;
const ADDRESS = re("вы|вам|вас|ваш\\p{L}*|ты|тебе|тебя|тво[йяёеию]\\p{L}*");
const SUPERLATIVE = re("№\\s?1|номер один|лучш\\p{L}*|единственн\\p{L}*|уникальн\\p{L}*|сам(?:ый|ая|ое|ые)\\s+\\p{L}+|лидер\\p{L}*");

/**
 * @param {object} entry
 * @param {{ stamps?: Array<{phrase:string}>, recentOpeners?: Array<{opener:string, name:string}>, codeWords?: string[] }} ctx
 */
export function speech(entry, ctx = {}) {
  const block = [];
  const warn = [];
  const text = whole(entry);
  const lower = text.toLowerCase();

  for (const s of ctx.stamps || []) {
    if (re(esc(String(s.phrase).toLowerCase())).test(lower)) block.push(`речь: штамп из списка «${s.phrase}»`);
  }

  const mine = opener(firstPart(entry));
  for (const prev of ctx.recentOpeners || []) {
    if (prev.opener && prev.opener === mine && prev.name !== entry.name) block.push(`речь: начало повторяет запись «${prev.name}». Одинаковый заход площадка и читатель видят сразу`);
  }

  const parallels = (text.match(PARALLEL) || []).length;
  if (parallels > 1) warn.push(`речь: оборот «не X, а Y» встретился ${parallels} раза. Один на текст, не больше`);
  const dashes = (text.match(LONG_DASH) || []).length;
  if (dashes > 2) warn.push(`речь: длинных тире ${dashes}. Замените запятой, двоеточием или точкой`);
  const sup = text.match(SUPERLATIVE);
  if (sup) warn.push(`речь: превосходная степень «${sup[0].trim()}». Закон о рекламе требует подтверждения таких слов: либо цифра и источник, либо убрать`);
  if ((text.match(/!/g) || []).length > 2) warn.push("речь: больше двух восклицательных знаков");

  if (entry.kind === "thread") {
    const posts = entry.posts || [];
    if (HASHTAG.test(text)) block.push("речь: хэштег в Threads. Площадка их не раздаёт, текст выглядит как реклама");
    if (EMOJI.test(text)) block.push("речь: эмодзи в ветке");
    for (const w of ctx.codeWords || []) {
      if (re(esc(w), "u").test(text)) block.push(`речь: кодовое слово бота «${w}» в Threads. Слова работают только в Instagram, здесь на него никто не ответит`);
    }
    const first = posts[0] || "";
    const firstSentence = first.split(/(?<=[.!?…])\s/)[0] || first;
    if (posts.length === 1) warn.push("речь: одиночный пост. По нашему замеру у ветки из двух и более реплик медиана просмотров вдвое выше");
    if (/\?\s*$/.test(firstSentence)) warn.push("речь: первая фраза вопросом. По замеру из 19 таких зачинов выстрелил один");
    if (ADDRESS.test(firstSentence)) warn.push("речь: обращение «вы/ты» в первой фразе. Зачин с героем или цифрой работает сильнее");
    if (!/\d/.test(first) && !/[«"][^»"]{2,}[»"]/.test(first) && !/(?<=[\p{Ll},:;]\s)\p{Lu}\p{Ll}{2,}/u.test(first)) {
      warn.push("речь: в первой реплике нет якоря: ни цифры, ни названного человека или компании");
    }
  }
  return { block, warn };
}

/* ── 3. Реклама на площадках с ограниченным доступом ───────────────────────── */

// Разбор своего товара и его свойств — можно. Нельзя то, что превращает текст в
// предложение купить: цена за единицу, скидка, акция, срок предложения, призыв заказать,
// телефон. Глагол в неопределённой форме («школа хотела заказать покрытие») встречается
// и в обычном рассказе, поэтому он только предупреждение, а повелительная форма
// («закажите») — отказ.
const AD_BLOCK = [
  [/\d[\d\s.,]*\s?(?:₽|руб(?:\.|л\p{L}*)?|тыс\.?\s?руб\p{L}*|млн\s?руб\p{L}*)\s?(?:\/|за)\s?(?:1\s?)?(?:м²|м2|кв\.?\s?м\p{L}*|кг|шт\p{L}*|мешок|тонн\p{L}*)/iu, "цена за единицу товара"],
  [/\d[\d\s]*\s?(?:₽|руб\p{L}*)\s?=\s?(?:1\s?)?(?:м²|м2)/iu, "цена за квадратный метр"],
  [re("от\\s+\\d[\\d\\s]*\\s?(?:₽|руб\\p{L}*)"), "цена «от …»"],
  [re("скидк\\p{L}*|распродаж\\p{L}*|промокод\\p{L}*|купон\\p{L}*|кэшб[еэ]к\\p{L}*"), "скидка или промокод"],
  [re("акци[яиюей]|акцией|акциях|по\\s+акции"), "акция"],
  [re("купите|покупайте|закажите|заказывайте|оформите\\s+заказ|оформляйте\\s+заказ|приобретайте|приобретите"), "призыв купить или заказать"],
  [re("оставьте\\s+заявку|оставляйте\\s+заявку|оставьте\\s+номер|звоните|позвоните|записывайтесь|запишитесь|вызовите\\s+замерщика|пишите\\s+в\\s+директ\\s+за\\s+(?:ценой|расч[её]том)"), "призыв оставить заявку или позвонить"],
  [re("успейте|только\\s+до\\s+\\d|осталось\\s+\\d+\\s+(?:мест\\p{L}*|дн\\p{L}*)|предложение\\s+ограничено"), "срочность предложения"],
  [re("бесплатн\\p{L}*\\s+(?:замер\\p{L}*|расч[её]т\\p{L}*|консультаци\\p{L}*|выезд\\p{L}*|доставк\\p{L}*)"), "бесплатная услуга как приманка"],
  [re("рассчитаем\\s+стоимость|рассчитаю\\s+стоимость|узнайте\\s+(?:цену|стоимость)|прайс(?:-лист)?|коммерческое\\s+предложение"), "предложение расчёта стоимости"],
  [/(?:\+7|(?<!\d)8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/u, "телефон"],
];
const AD_WARN = [
  [re("купить|заказать|приобрести|оформить\\s+заказ|оставить\\s+заявку"), "слова «купить», «заказать»: проверьте, что это рассказ, а не предложение"],
];

/**
 * @param {object} entry
 * @param {{ restricted?: boolean }} ctx restricted — площадка с ограниченным доступом
 */
export function adlaw(entry, ctx = {}) {
  const block = [];
  const warn = [];
  const text = whole(entry);
  const hits = [];
  for (const [pattern, title] of AD_BLOCK) {
    const m = text.match(pattern);
    if (m) hits.push(`${title} («${m[0].trim().slice(0, 40)}»)`);
  }
  if (hits.length && ctx.restricted) {
    block.push(`реклама: ${hits.join("; ")}. На этой площадке действует запрет рекламы (ч. 10.7 ст. 5 закона «О рекламе»): здесь только разборы и польза, предложения уходят во ВКонтакте, Rutube, Дзен и в личную переписку`);
  } else if (hits.length) {
    warn.push(`реклама: в тексте есть ${hits.join("; ")}. Площадка открытая, это допустимо; проверьте, что цена и условия совпадают с сайтом на сегодня`);
  }
  if (ctx.restricted) {
    for (const [pattern, title] of AD_WARN) {
      const m = text.match(pattern);
      if (m) warn.push(`реклама: ${title} («${m[0].trim()}»)`);
    }
  }
  return { block, warn };
}

/* ── 4. Факты ──────────────────────────────────────────────────────────────── */

const UNIT = /^\s?(?:%|‰|мм|см|м²|м2|м(?!\p{L})|кв\.|км|кг|г(?!\p{L})|тонн|т(?!\p{L})|млн|млрд|тыс|лет|год|месяц|недел|дн|час|минут|раз|°|градус|₽|руб|шт|человек|объект|бригад|город|стран|цвет)/iu;
// Номер документа источником не подтверждают: он сам и есть ссылка.
const DOC_BEFORE = /(?:№|ГОСТ(?:\s+Р)?|ТР\s+(?:ЕАЭС|ТС)|СП|СНиП|EN|ISO|приказ\p{L}*|стать\p{L}+|ст\.|ч\.|п\.|пункт\p{L}*|часть|закон\p{L}*)\s*(?:№\s*)?[\d.\/-]*$/iu;
const DOC_AFTER = /^(?:-ФЗ|\/\d{4}|-\d{2,4}(?!\d))/u;
const digits = (s) => String(s).replace(/[^\d]/g, "");
const isYear = (d) => d.length === 4 && Number(d) >= 1900 && Number(d) <= 2099;

/**
 * Числа, которым нужен источник. Пропускаем: годы, время и даты, номера документов,
 * одиночные цифры без единицы («5 ошибок»), нумерацию списка.
 */
export function numbersIn(text) {
  const src = String(text || "").replace(/https?:\/\/\S+/g, " ");
  const out = [];
  const token = /(?<![\p{L}\d.,:])(?:\d{1,3}(?:[   ]\d{3})+|\d+)(?:[.,]\d+)?/gu;
  for (const m of src.matchAll(token)) {
    const raw = m[0];
    const before = src.slice(Math.max(0, m.index - 24), m.index);
    const after = src.slice(m.index + raw.length, m.index + raw.length + 12);
    const d = digits(raw);
    if (/^[:.]\d/.test(after) && /^\d{1,2}$/.test(raw)) continue; // время 19:30 и дата 15.10
    if (/^\s?(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/iu.test(after)) continue;
    if (isYear(d) && !/[.,]/.test(raw)) continue;
    if (DOC_BEFORE.test(before) || DOC_AFTER.test(after)) continue;
    if (/^\s*[.)]\s/.test(after) && /(?:^|\n)\s*$/.test(before)) continue; // пункт списка «1. …»
    if (d.length < 2 && !UNIT.test(after)) continue;
    out.push(raw.trim());
  }
  return [...new Set(out)];
}

/**
 * Каждая цифра в тексте должна быть в entry.facts: [{ claim, source }].
 * source — адрес страницы либо «интервью <кто>, <дата>», «документ клиента: <какой>».
 */
export function facts(entry) {
  const block = [];
  const warn = [];
  const list = Array.isArray(entry.facts) ? entry.facts : [];
  for (const f of list) if (f && f.claim && !f.source) block.push(`факты: у утверждения «${String(f.claim).slice(0, 50)}» не указан источник`);
  const found = numbersIn(whole(entry));
  if (!found.length) return { block, warn };
  const covered = list.filter((f) => f && f.claim && f.source).map((f) => digits(f.claim));
  const naked = found.filter((n) => !covered.some((c) => c.includes(digits(n))));
  if (naked.length) block.push(`факты: цифры без источника: ${naked.slice(0, 8).join(", ")}. Добавьте их в поле facts записи: что утверждаем и откуда это известно`);
  return { block, warn };
}

/** Все проверки разом. */
export function checkAll(entry, ctx = {}) {
  const out = { block: [], warn: [] };
  for (const r of [ready(entry), speech(entry, ctx), adlaw(entry, ctx), facts(entry)]) {
    out.block.push(...r.block);
    out.warn.push(...r.warn);
  }
  return out;
}
