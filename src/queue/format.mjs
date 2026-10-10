// Очередь выпуска: общий формат записи. Чистый модуль: без сети, файлов и окружения,
// поэтому один и тот же файл читают сервер, компьютер оператора и тесты.
//
// ОДНА ЗАПИСЬ = ОДИН МАТЕРИАЛ НА ОДНОЙ ПЛОЩАДКЕ В ОДИН СЛОТ.
// Статья, разошедшаяся в Threads, Telegram и ВКонтакте, даёт три записи с общим
// полем material: по нему журнал и отчёт видят, что это один материал.
//
// Статусы и переходы. Запись двигается только по таблице ниже; всё остальное — отказ
// по правилу (код выхода 1), а не поломка.
//
//   draft ──▶ review ──▶ approved ──▶ running ──▶ published
//     ▲         │  ▲         │           │
//     │         ▼  │         ├──▶ expired (опоздала больше предела)
//     └────── rework         └──▶ failed (три попытки) ──▶ approved (вернули руками)
//   любая незавершённая ──▶ cancelled
//
//  · review   — карточка ушла в рабочую группу, ждём «да» человека клиента;
//  · rework   — человек нажал «Правка» и написал, что не так;
//  · approved — «да» получено, запись ждёт своего слота;
//  · running  — пишется ДО отправки на площадку: второй проход эту запись не возьмёт.

export const STATUSES = ["draft", "review", "rework", "approved", "running", "published", "failed", "expired", "cancelled"];

export const STATUS_TITLE = {
  draft: "черновик",
  review: "ждёт согласования",
  rework: "на правке",
  approved: "одобрено, ждёт слота",
  running: "выходит",
  published: "вышло",
  failed: "ошибка",
  expired: "просрочено",
  cancelled: "снято",
};

const MOVES = {
  draft: ["review", "cancelled"],
  review: ["approved", "rework", "cancelled", "draft"],
  rework: ["draft", "review", "cancelled"],
  approved: ["running", "expired", "cancelled", "review"],
  running: ["published", "approved", "failed"],
  failed: ["approved", "cancelled"],
  expired: ["approved", "cancelled"],
  published: [],
  cancelled: [],
};

export const canMove = (from, to) => (MOVES[from] || []).includes(to);
export const isFinal = (status) => status === "published" || status === "cancelled";

/** Вид материала по площадке. Проверка не даст поставить ветку в YouTube. */
export const KINDS = {
  threads: ["thread"],
  telegram: ["post"],
  vk: ["post", "video"],
  dzen: ["article"],
  instagram: ["reel", "carousel", "story"],
  youtube: ["video", "short"],
  rutube: ["video", "short"],
  bot: ["post"],
};

/** Предел одной реплики Threads и число реплик в ветке. */
export const POST_LIMIT = 500;
export const MAX_POSTS = 12;

/** Пределы текста по площадкам (знаков). Длиннее площадка обрежет или откажет. */
export const TEXT_LIMIT = {
  telegram: 4096,
  telegramCaption: 1024,
  vk: 15000,
  instagram: 2200,
  youtubeTitle: 100,
  youtubeDescription: 5000,
  rutubeTitle: 100,
  rutubeDescription: 5000,
  dzen: 60000,
  bot: 3900,
};

const clean = (v) => String(v ?? "").replace(/\r\n?/g, "\n").trim();

/** Текст файла ветки → реплики. Разделитель — строка из трёх дефисов. */
export function splitPosts(fileText) {
  return String(fileText ?? "").replace(/\r\n?/g, "\n").split(/^---\s*$/m).map((t) => t.trim()).filter(Boolean);
}

/* FNV-1a в два прохода: короткий устойчивый отпечаток без node:crypto.
   Криптостойкость не нужна: это номер записи и сверка «изменилось или нет». */
function fnv(s, seed) {
  let h = seed >>> 0;
  for (const byte of new TextEncoder().encode(s)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
const fnv16 = (s) => fnv(s, 0x811c9dc5) + fnv(s, 0x9747b28c);

/** Номер записи: площадка + имя. Перенос времени номер не меняет, поэтому дубля не будет. */
export function entryId(channel, name) {
  return fnv16(`${clean(channel)}:${clean(name).toLowerCase()}`);
}

/**
 * Содержимое записи: всё, что увидит читатель. Хэштеги и ссылки ролика (goSlug, botKey,
 * article) сюда входят: их видно в описании. Серия и «смотрите также» не входят: это
 * связи между роликами, они меняются с выходом каждой новой части и согласия не требуют.
 */
function content(e) {
  const base = [e.channel, e.kind, e.title || "", e.text || "", e.posts || [], (e.media || []).map((m) => [m.type, m.url, m.cover || ""]), e.buttons || [], e.link || "", e.tags || []];
  const video = [e.hashtags || [], e.goSlug || "", e.botKey || "", e.article || ""];
  // Поля ролика добавляются, только когда они заданы: у записей без них отпечаток прежний.
  return video.some((v) => (Array.isArray(v) ? v.length : v)) ? [...base, video] : base;
}

/** Отпечаток содержимого. Изменился после одобрения — запись снова идёт на согласование. */
export const contentHash = (e) => fnv16(JSON.stringify(content(e)));

/** Отпечаток «что и когда»: по нему дубль расписания понимает, отстала ли копия. */
export const entryHash = (e) => fnv16(JSON.stringify([content(e), e.date, e.time]));

/** Приводит сырую запись к формату. Лишние поля не выбрасываются, только чистятся известные. */
export function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const e = {
    ...r,
    channel: clean(r.channel).toLowerCase(),
    kind: clean(r.kind).toLowerCase(),
    name: clean(r.name).slice(0, 80),
    material: clean(r.material),
    date: clean(r.date),
    time: clean(r.time),
  };
  if (r.posts !== undefined) e.posts = (Array.isArray(r.posts) ? r.posts : splitPosts(r.posts)).map(clean).filter(Boolean);
  if (r.text !== undefined) e.text = clean(r.text);
  if (r.title !== undefined) e.title = clean(r.title);
  if (r.link !== undefined) e.link = clean(r.link);
  if (r.media !== undefined) e.media = (Array.isArray(r.media) ? r.media : []).map((m) => ({ ...m, type: clean(m?.type), url: clean(m?.url), ...(m?.cover ? { cover: clean(m.cover) } : {}) }));
  if (r.tags !== undefined) e.tags = (Array.isArray(r.tags) ? r.tags : []).map(clean).filter(Boolean);
  e.id = clean(r.id) || (e.channel && e.name ? entryId(e.channel, e.name) : "");
  e.status = STATUSES.includes(r.status) ? r.status : "draft";
  return e;
}

const isHttps = (u) => /^https:\/\/[^\s]+$/.test(String(u || ""));

/**
 * Претензии к записи человеческими словами. Пустой список — запись годна по формату.
 * Это проверка формы. Речь и запрет рекламы проверяют отдельные проверки (src/gates).
 */
export function validate(e) {
  const bad = [];
  if (!/^[0-9a-f]{16}$/.test(e.id || "")) bad.push("номер записи: нужно 16 шестнадцатеричных знаков");
  if (!KINDS[e.channel]) bad.push(`площадка «${e.channel}»: такой нет (есть ${Object.keys(KINDS).join(", ")})`);
  else if (e.kind !== "reply" && !KINDS[e.channel].includes(e.kind)) bad.push(`вид «${e.kind}» на площадке ${e.channel} не выходит (можно ${KINDS[e.channel].join(", ")})`);
  if (!e.name) bad.push("нет имени записи");
  if (!e.material) bad.push("нет поля material: из чего сделан материал (статья, новость, интервью)");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || "") || !/^\d{2}:\d{2}$/.test(e.time || "") || !Number.isFinite(Date.parse(`${e.date}T${e.time}:00+03:00`))) {
    bad.push(`дата и время «${e.date} ${e.time}»: нужно ГГГГ-ММ-ДД и ЧЧ:ММ по Москве`);
  }

  const media = e.media || [];
  for (const m of media) {
    if (!["image", "video"].includes(m.type)) bad.push(`вложение: тип «${m.type}», нужен image или video`);
    // Файл площадка забирает сама и только по публичному адресу: с диска и с сайта не берёт.
    if (!isHttps(m.url)) bad.push("вложение: нужен публичный адрес с https://, а не путь на диске");
    if (m.cover && !isHttps(m.cover)) bad.push("обложка: нужен публичный адрес с https://");
  }
  const videos = media.filter((m) => m.type === "video").length;
  const images = media.filter((m) => m.type === "image").length;

  switch (e.kind) {
    case "thread": {
      const posts = e.posts || [];
      if (!posts.length) bad.push("в ветке нет ни одной реплики");
      if (posts.length > MAX_POSTS) bad.push(`реплик ${posts.length}, больше ${MAX_POSTS} ветка не бывает`);
      posts.forEach((p, i) => { if (p.length > POST_LIMIT) bad.push(`реплика ${i + 1}: ${p.length} знаков, предел ${POST_LIMIT}`); });
      if (media.length > 1) bad.push("у ветки одна картинка, и только у первой реплики");
      if (videos) bad.push("видео в Threads не ставим: охват у него на порядок ниже текста");
      break;
    }
    case "post": {
      if (!e.text) bad.push("у поста нет текста");
      const limit = e.channel === "telegram" ? (media.length ? TEXT_LIMIT.telegramCaption : TEXT_LIMIT.telegram) : TEXT_LIMIT[e.channel];
      if (limit && (e.text || "").length > limit) bad.push(`текст ${e.text.length} знаков, предел площадки ${limit}`);
      break;
    }
    case "article": {
      if (!e.title) bad.push("у статьи нет заголовка");
      if ((e.text || "").length < 800) bad.push("статья короче 800 знаков: для Дзена это заметка, а не материал");
      break;
    }
    case "reel":
    case "short":
    case "video": {
      if (videos !== 1) bad.push("нужен ровно один видеофайл");
      if (e.channel === "instagram") {
        if ((e.text || "").length > TEXT_LIMIT.instagram) bad.push(`подпись ${e.text.length} знаков, предел ${TEXT_LIMIT.instagram}`);
      } else {
        if (!e.title) bad.push("у ролика нет названия");
        if ((e.title || "").length > 100) bad.push(`название ${e.title.length} знаков, предел 100`);
        if ((e.text || "").length > 5000) bad.push(`описание ${e.text.length} знаков, предел 5000`);
      }
      break;
    }
    case "carousel": {
      if (images < 2 || images > 10) bad.push(`в карусели ${images} картинок, нужно от 2 до 10`);
      if (videos) bad.push("карусель собираем из картинок");
      break;
    }
    case "reply": {
      // Ответ компании на комментарий: такая же публикация, поэтому идёт через согласование.
      if (!e.text) bad.push("у ответа нет текста");
      if ((e.text || "").length > 1000) bad.push(`ответ ${e.text.length} знаков: это уже статья, а не ответ. Предел 1000`);
      if (!isHttps(e.link)) bad.push("у ответа нет ссылки на комментарий (поле link)");
      break;
    }
    case "story": {
      if (media.length !== 1) bad.push("история: ровно одно вложение");
      break;
    }
    default:
      break;
  }
  return bad;
}

/** Короткая строка для списков и сводок: начало того, что прочтёт человек. */
export function preview(e, n = 70) {
  const s = (e.posts?.[0] || e.title || e.text || e.name || "").replace(/\s+/g, " ");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
