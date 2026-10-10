// Проверки текста перед выходом. Чистые функции: текст на вход, претензии на выход.
//
// ПЯТЬ ПРОВЕРОК НА ДВУХ ПОСТАХ. При постановке на согласование работают все пять:
// рядом оператор, он поправит. Перед самым выпуском останавливают только готовность и
// реклама. Одной заставы на входе мало: у нас каркас с заглушкой однажды уехал в живой
// канал уже одобренным. А речь, факты и ролик на выпуске не останавливают: человек клиента
// их уже видел в карточке и сказал «да», и снимать одобренное новой придиркой нельзя.
//
//   готовность — текст дописан, а не оставлен каркасом;
//   речь       — нет штампов, счётчиков, повтора прошлых заходов;
//   реклама    — на площадках с ограниченным доступом нет цен, акций и призывов купить;
//   факты      — у каждой цифры в тексте есть источник;
//   ролик      — название, первая строка описания, ссылка и хэштеги собраны по схеме.
//
// block останавливает запись. warn — повод перечитать: решает человек, который
// согласует. Правило добавляется только с примером текста, на котором оно сработало:
// проверка, которая ругается зря, за неделю приучает не читать её вывод.
//
// ГРАНИЦЫ СЛОВ. `\b` в JavaScript не видит кириллицу: проверки с ним у нас месяц молча
// не работали. Границы считаются через \p{L} и флаг u.

import { MARK, goLinksIn } from "../leads/marks.mjs";
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

/** Всё, где в записи может стоять ссылка: текст, вложенная ссылка, кнопки под постом. */
const linkPlaces = (entry) => [whole(entry), entry.link || "", ...(entry.buttons || []).flat().map((b) => b?.url || "")].join("\n");

/**
 * Куда в записи зовут человека оставить данные. Пустой список — никуда.
 * @param {{ codeWords?: string[], linkTargets?: Record<string, string> }} ctx
 */
export function intakeIn(entry, ctx = {}) {
  const text = whole(entry);
  const places = linkPlaces(entry);
  const hits = [];
  if (entry.channel === "bot") hits.push("рассылка в боте");
  if (entry.botKey) hits.push(`ссылка в бота (поле botKey = «${entry.botKey}»)`);
  if (/https?:\/\/t\.me\/\w+\?start=/i.test(places)) hits.push("ссылка в бота");
  if (/\/z\/[a-z0-9_-]+/i.test(places)) hits.push("ссылка на форму заявки");
  for (const w of ctx.codeWords || []) if (re(esc(w), "u").test(text)) hits.push(`кодовое слово «${w}»`);
  for (const slug of [entry.goSlug, ...goLinksIn(places).map((l) => l.slug)].filter(Boolean)) {
    if (/t\.me\/|\/z\//i.test(ctx.linkTargets?.[slug] || "")) hits.push(`ссылка /go/${slug}, которая ведёт в бота или на форму`);
  }
  return [...new Set(hits)];
}

/**
 * @param {object} entry
 * @param {{ links?: string[], legal?: boolean, codeWords?: string[], linkTargets?: Record<string, string> }} ctx
 *   links — слаги коротких ссылок из bot/links.json; legal — открыт ли приём заявок
 */
export function ready(entry, ctx = {}) {
  const block = [];
  const warn = [];
  const text = whole(entry);

  /* Приём заявок закрыт, пока юрист клиента не утвердил тексты согласий: бот людям не
     отвечает, форма отдаёт отказ, на кодовое слово не ответит никто. Публикация, которая
     зовёт туда, оставляет человека ни с чем, и это худший исход просмотра. Проверка стоит
     в готовности, потому что готовность останавливает и перед самым выпуском: запись,
     одобренная при открытом приёме, не выйдет, если приём с тех пор закрылся. */
  if (ctx.legal === false) {
    const hits = intakeIn(entry, ctx);
    if (hits.length) block.push(`готовность: приём заявок закрыт, а в записи есть ${hits.join("; ")}. Человек придёт и получит отказ. Пока согласия не утверждены (npm run doctor, раздел «Бот»), ведите по прямой ссылке на статью сайта`);
  }

  /* Ссылки через счётчик переходов. Неизвестный слаг сервер молча ведёт на главную сайта:
     человек нажал «чек-лист» и попал не туда. Метка площадки в ссылке решает, кому
     запишется переход и заявка: перепутанная метка ничего не ломает, но отчёт врёт. */
  if (Array.isArray(ctx.links)) {
    const known = new Set(ctx.links);
    const mark = MARK[entry.channel];
    for (const l of goLinksIn(linkPlaces(entry))) {
      if (!known.has(l.slug)) block.push(`готовность: ссылка «${l.raw.slice(0, 60)}» ведёт в никуда: слага «${l.slug}» нет в bot/links.json, человек попадёт на главную сайта`);
      else if (!l.c) warn.push(`готовность: в ссылке /go/${l.slug} нет метки площадки (c=${mark}): переход не запишется ни одной площадке`);
      else if (mark && l.c !== mark && !l.c.startsWith(`${mark}-`)) warn.push(`готовность: в ссылке /go/${l.slug} метка площадки «${l.c}», а запись выходит на ${entry.channel} (метка ${mark}): переход запишется не той площадке`);
    }
    for (const field of ["goSlug", "article"]) {
      if (entry[field] && !known.has(String(entry[field]))) block.push(`готовность: поле ${field} = «${entry[field]}», такого слага нет в bot/links.json`);
    }
  }
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
  return { block, warn };
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

  /* Кодовое слово бота живёт только в Instagram: там его ловит бот и отвечает в директ.
     На любой другой площадке человек напишет слово и не получит ничего: это худшее, чем
     может кончиться просмотр. Ищем слово ЗАГЛАВНЫМИ: «приёмка» строчными — обычное слово. */
  if (entry.channel !== "instagram") {
    for (const w of ctx.codeWords || []) {
      if (re(esc(w), "u").test(text)) block.push(`речь: кодовое слово бота «${w}» на площадке ${entry.channel}. Слова работают только в Instagram, здесь на него никто не ответит: дайте прямую ссылку`);
    }
  }

  if (entry.kind === "thread") {
    const posts = entry.posts || [];
    if (HASHTAG.test(text)) block.push("речь: хэштег в Threads. Площадка их не раздаёт, текст выглядит как реклама");
    if (EMOJI.test(text)) block.push("речь: эмодзи в ветке");
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
/* Сумма и единица товара собраны отдельно: цену пишут и знаком («1500 ₽/м²»), и словами
   («1500 рублей за квадратный метр»). Первая версия знала только знаки, и ролик с ценой,
   произнесённой по-человечески, проходил проверку на площадке с запретом рекламы. */
// Валюта обязательна: «14 тысяч квадратных метров» — площадь, а не сумма.
const MONEY = "(?:₽|руб(?:\\.|л\\p{L}*)?(?!\\p{L})|тыс(?:\\.|яч\\p{L}*)?\\s?(?:₽|руб\\p{L}*\\.?)|млн\\.?\\s?(?:₽|руб\\p{L}*\\.?)|млрд\\.?\\s?(?:₽|руб\\p{L}*\\.?))";
const AMOUNT = `\\d[\\d\\s.,]*\\s?${MONEY}`;
// «1500 р/м²»: сокращение «р» считается деньгами только перед косой чертой.
const AMOUNT_PER = `(?:${AMOUNT}|\\d[\\d\\s.,]*\\s?р\\.?(?=\\s?\\/))`;
const GOODS = "(?:м²|м2|кв\\.?\\s?м\\p{L}*|квадратн\\p{L}*\\s+метр\\p{L}*|квадрат(?!\\p{L})|погонн\\p{L}*\\s+метр\\p{L}*|метр\\p{L}*|кг|килограмм\\p{L}*|шт\\p{L}*|мешок|мешк\\p{L}*|тонн\\p{L}*|литр\\p{L}*|ведр\\p{L}*|рулон\\p{L}*|плит\\p{L}*|комплект\\p{L}*|набор\\p{L}*)";
// «стоит 24 996 ₽», «цена 1 500 рублей», «обойдётся в 300 тысяч»: цена названа глаголом.
const PRICED = "(?:стоит|стоят|стоил\\p{L}*|стоимост\\p{L}*|цен[аыеуой]\\p{L}*|обойд[её]тся|обойдутся|обош[её]?л\\p{L}*|продаём\\s+за|продаем\\s+за|отдаём\\s+за|отдаем\\s+за)";

const AD_BLOCK = [
  [new RegExp(`${AMOUNT_PER}\\s?(?:\\/|за|на)\\s?(?:1\\s?|один\\s+|одну\\s+)?${GOODS}`, "iu"), "цена за единицу товара"],
  [new RegExp(`(?<!\\p{L})(?:за|на)\\s+(?:1\\s?|один\\s+|одну\\s+)?${GOODS}[^.!?\\n\\d]{0,24}${AMOUNT}`, "iu"), "цена за единицу товара"],
  [new RegExp(`\\d[\\d\\s]*\\s?(?:₽|руб\\p{L}*)\\s?=\\s?(?:1\\s?)?(?:м²|м2)`, "iu"), "цена за квадратный метр"],
  [new RegExp(`${B}${PRICED}\\s+(?:\\p{L}+\\s+){0,3}?(?:в\\s+|от\\s+|до\\s+|около\\s+|примерно\\s+|всего\\s+)?\\d[\\d\\s.,]*\\s?(?:${MONEY}|тыс(?:\\.|яч\\p{L}*)|млн)`, "iu"), "названа цена"],
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
// Сумма сама по себе не реклама: штраф, сумма контракта из закупок, цифра из закона.
// Отличить её от цены своего товара программа не может, поэтому решает человек.
const ANY_SUM = new RegExp(AMOUNT, "iu");

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
    if (m) hits.push(`${title} («${m[0].trim().slice(0, 70)}»)`);
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
    const sum = hits.length ? null : text.match(ANY_SUM);
    if (sum) warn.push(`реклама: сумма в рублях («${sum[0].trim().replace(/[.,]$/, "").slice(0, 40)}»). Цену своего товара на этой площадке не называем. Штраф, сумму контракта из открытых закупок и цифру из закона оставить можно: решает утверждающий`);
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
/** Число к одному виду: «1 500» и «1500» равны, «2,5» и «2.5» равны, «25» им не равно. */
export const normalNumber = (s) => String(s).replace(/[\s  ]/g, "").replace(",", ".");
/** Все числа строки в едином виде: по ним утверждение сверяется с текстом. */
export const numberTokensIn = (s) => (String(s || "").match(/(?<![\p{L}\d.,])(?:\d{1,3}(?:[   ]\d{3})+|\d+)(?:[.,]\d+)?/gu) || []).map(normalNumber);

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
  /* Число из текста должно стоять в утверждении целиком. Сравнение по вхождению цифр
     пропускало «14 вырубок» под источником, в котором было только «2014»: любая цифра
     находилась внутри какой-нибудь другой. */
  const covered = new Set(list.filter((f) => f && f.claim && f.source).flatMap((f) => numberTokensIn(f.claim)));
  const naked = found.filter((n) => !covered.has(normalNumber(n)));
  if (naked.length) block.push(`факты: цифры без источника: ${naked.slice(0, 8).join(", ")}. Добавьте их в поле facts записи: что утверждаем и откуда это известно`);
  return { block, warn };
}

/* ── 5. Ролик: название, описание, подпись ─────────────────────────────────── */

// Правила взяты с нашего канала: 96 коротких роликов и разбор, почему часть не полетела.
const TITLE_NUMBER = /\d[\d\s.,]{0,6}\d|\b\d\b%?/gu;
const DATED = /(?<!\d)\d{1,2}(?:\s?[–-]\s?\d{1,2})?\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/iu;
const withoutLinks = (t) => String(t || "").replace(/https?:\/\/\S+/gu, "");
const numberTokens = (t) => new Set((withoutLinks(t).match(TITLE_NUMBER) || []).map((x) => x.trim()).filter((x) => x.length > 1));

/**
 * Числа из названия, повторённые в первой строке описания. Первая строка — единственное,
 * что видно без разворачивания; если в ней уже стоит ответ из названия, смотреть незачем.
 * Сравниваются только числа: название компании или объекта законно повторяется.
 */
export function spoilers(title, description) {
  const firstLine = String(description || "").split(/\r?\n/).find((l) => l.trim()) || "";
  const inTitle = numberTokens(title);
  const inFirst = numberTokens(firstLine);
  return { firstLine, common: [...inTitle].filter((x) => inFirst.has(x)) };
}

export function video(entry) {
  const block = [];
  const warn = [];
  if (!["video", "short", "reel"].includes(entry.kind)) return { block, warn };
  const text = String(entry.text || "");
  if (entry.channel === "instagram") {
    const first = text.split("\n")[0] || "";
    if (first.length > 60) warn.push(`ролик: первая строка подписи ${first.length} знаков. В ленте видно около сорока: первая строка короткая и самостоятельная`);
    if (/https?:\/\//.test(text)) warn.push("ролик: ссылка в подписи Instagram не нажимается. Материал отдаёт кодовое слово");
    return { block, warn };
  }
  const { common } = spoilers(entry.title, text);
  if (common.length) block.push(`ролик: первая строка описания повторяет число из названия (${common.join(", ")}). Её видно без разворачивания, и готовый ответ в ней убивает желание смотреть`);
  if ((entry.title || "").length > 80) warn.push(`ролик: название ${entry.title.length} знаков. В ленте видно первые шестьдесят–семьдесят`);
  if (/^(?:как|почему|зачем|что такое|топ|\d+\s+(?:способ|совет|причин|ошиб))/iu.test((entry.title || "").trim())) warn.push("ролик: название похоже на тему или список. Сильнее работает событие или поступок: что произошло, с кем и чем кончилось");
  if (!entry.goSlug && !entry.botKey && !/https?:\/\//.test(text)) warn.push("ролик: в описании нет прямой ссылки. Укажите в записи goSlug (ссылка на материал) или botKey (ссылка в бота): зрителю некуда идти");
  const dated = text.match(DATED);
  if (dated && !entry.event) warn.push(`ролик: в описании дата («${dated[0]}»). Ролик живёт на канале годами, дата протухнет. Если это событие, поставьте в записи event: true`);
  const tags = entry.hashtags || [];
  if (tags.length > 5) warn.push(`ролик: хэштегов ${tags.length}, достаточно пяти`);
  if (entry.channel === "youtube" && !tags.length) warn.push("ролик: нет хэштегов (поле hashtags, до пяти)");
  if (/(?:^|\n)\s*#[\p{L}\d_]+/u.test(text)) warn.push("ролик: хэштеги в самом тексте. Перенесите их в поле hashtags: блок ссылок и хэштегов под текстом собирает программа");
  return { block, warn };
}

/** Все проверки разом. */
export function checkAll(entry, ctx = {}) {
  const out = { block: [], warn: [] };
  for (const r of [ready(entry, ctx), speech(entry, ctx), adlaw(entry, ctx), facts(entry), video(entry)]) {
    out.block.push(...r.block);
    out.warn.push(...r.warn);
  }
  return out;
}
