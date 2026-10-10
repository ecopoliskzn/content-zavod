// Утренний отчёт v2 (Фаза 4, D-011/D-014, воронка v2 — .planning/plans/BOT-ALYONA-FUNNEL-V2.md,
// разделы «Владелец и Алёна: утренний отчёт» и «Контракт данных»). Строит два текста из
// tg-subscribers.jsonl (последняя запись по id побеждает — см. telegram/store.mjs):
//
//   text        — Алёне/продавцу в тему уведомлений: воронка, источники, «ждут ответа»
//                 (карточки без «Взял в работу» со ссылкой на сообщение), топ болей за неделю.
//   ownerSummary — владельцу: те же числа, БЕЗ единого имени/ника/телефона/ссылки на человека.
//
// Контракт полей подписчика (пишет apps/bot-alyona/src/*, читает только этот модуль):
//   funnel: { startedAt, consentAt, materialAt, diagStartedAt, diagDoneAt, leadAt, leadCancelledAt }
//   entryOrigin: "instagram" | "site" | "telegram", entryKey
//   diag.итог: { band, title, weak: [echo…] }
//   lead: { contact, phone, comment, status: "new" | "cancelled" }
//   salesCard: { messageId, status: "diag" | "lead" | "cancelled", takenBy, takenAt, rejectedBy, rejectedAt }
//   isTest: true
//
// Старые записи (без funnel/salesCard/isTest — переходный период, пока предыдущие фазы
// не переписаны) не должны ронять отчёт: там, где нового поля нет, модуль подстраховывается
// сырыми логами (tg-events.jsonl — "пришли", leads.jsonl — "заявки"), как это делал отчёт v1.
// Чего восстановить из старых записей нельзя (согласие/статья/начало-конец диагностики без
// funnel) — просто не считается для этого человека, отчёт не падает и не подставляет вымысел.

import { promises as fs } from "node:fs";
import path from "node:path";

async function readJsonl(file) {
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** То же самое плюс кавычки — для значений внутри href="…" (Ждут ответа: имя-ссылка). */
function escapeHtmlAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function bold(s) {
  return `<b>${s}</b>`;
}

function капитализировать(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function inWindow(iso, startMs, endMs) {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) && t >= startMs && t <= endMs;
}

function hoursAgo(iso, now) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (now.getTime() - t) / 3600_000);
}

function formatAge(h) {
  return h < 1 ? "<1 ч" : `${Math.floor(h)} ч`;
}

function periodPhrase(hours) {
  if (hours === 24) return "за сутки";
  if (hours === 168) return "за неделю";
  return `за ${hours} ч`;
}

/** DD.MM по Москве, как в scripts/tg-post.mjs (день публикации). */
function moscowDate(now) {
  return now.toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit" });
}

/** Ссылка на карточку в теме уведомлений: t.me/c/<chatId без -100>/<messageId>.
 *  Экспортирован отдельно — формат ссылки проверяется тестом без сборки всего отчёта. */
export function cardLink(notifyChatId, messageId) {
  if (!notifyChatId || !messageId) return undefined;
  const raw = String(notifyChatId).replace(/^-100/, "").replace(/^-/, "");
  if (!raw) return undefined;
  return `https://t.me/c/${raw}/${messageId}`;
}

function displayName(sub) {
  const izProfile = [sub?.profile?.firstName, sub?.profile?.lastName].filter(Boolean).join(" ").trim();
  if (izProfile) return izProfile;
  if (sub?.name) return sub.name;
  const legacy = [sub?.firstName, sub?.lastName].filter(Boolean).join(" ").trim();
  return legacy || "без имени";
}

/** Легаси-поле "источник" ("alyona:rol-hr") — ключ материала без префикса сети (до entryKey). */
function legacyKeyFrom(sub) {
  const src = sub?.источник;
  if (typeof src !== "string") return undefined;
  return src.includes(":") ? src.split(":").slice(1).join(":") : src;
}

function topEntries(map, n) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), "ru"))
    .slice(0, n);
}

const STAGE_KEYS = ["startedAt", "consentAt", "materialAt", "diagStartedAt", "diagDoneAt", "leadAt"];

const DEFAULT_LABELS = {
  titlePrefix: "Утро",
  funnelTitlePrefix: "Воронка",
  funnelSteps: ["пришли", "согласились", "статья", "начали проверку", "прошли", "заявки"],
  sourceTitle: "Откуда",
  sourceNames: { instagram: "Instagram", threads: "Threads", site: "Сайт", telegram: "Telegram" },
  keysPrefix: "Ключи",
  waitlistPrefix: "Лист ожидания",
  waitingTitle: "Ждут ответа",
  waitingMore: (n) => `и ещё ${n}`,
  weakTitle: "Что болит чаще всего",
  emptyLine: "пока пусто",
  waitingEmoji: { lead: "🔥", diag: "🟡" },
};

/**
 * @param {object} config
 * @param {string} config.storageDir каталог jsonl-журналов инстанса
 * @param {(string|number)[]} [config.excludeIds] ID тестовых аккаунтов (ALYONA_TEST_ACCOUNT_IDS) —
 *   исключаются из отчёта целиком, в дополнение к записям с isTest:true
 * @param {number} [config.hours] окно отчёта в часах (по умолчанию 24)
 * @param {number} [config.weakDays] окно для топа «болит» в днях (по умолчанию 7)
 * @param {string} [config.notifyChatId] чат темы «Заявки Алёны» — для ссылок на карточки
 * @param {object} [config.labels] переопределение русских подписей (для будущих сайтов сети)
 * @param {Record<string,string>} [config.keyLabels] человеческие подписи ключей материалов
 *   для секции «Откуда» (key → word, например "rol-hr" → "РОЛЬ HR"). Пакет @liga/bot
 *   контент приложения не читает — карту собирает и передаёт вызывающий скрипт
 *   (apps/bot-alyona/scripts/report.mjs — из content/materials.json). Ключ без записи
 *   в карте показывается как есть.
 */
export function createReportBuilder(config = {}) {
  const storageDir = config.storageDir;
  if (!storageDir) throw new TypeError("createReportBuilder: нужен storageDir");
  const excludeIds = new Set((config.excludeIds || []).map(String));
  const hours = config.hours || 24;
  const weakDays = config.weakDays || 7;
  const notifyChatId = config.notifyChatId || "";
  const keyLabels = config.keyLabels || {};
  const labels = { ...DEFAULT_LABELS, ...(config.labels || {}) };

  function isExcluded(sub, id) {
    if (excludeIds.has(String(id))) return true;
    if (sub?.isTest) return true;
    if (sub?.status === "excluded") return true;
    return false;
  }

  async function build(now = new Date()) {
    const endMs = now.getTime();
    const startMs = endMs - hours * 3600_000;
    const weakStartMs = endMs - weakDays * 24 * 3600_000;

    const subsRaw = await readJsonl(path.join(storageDir, "tg-subscribers.jsonl"));
    const subsById = new Map();
    for (const s of subsRaw) if (s?.id) subsById.set(String(s.id), s);

    const активные = [...subsById.entries()].filter(([id, s]) => !isExcluded(s, id));

    const stageSets = Object.fromEntries(STAGE_KEYS.map((k) => [k, new Set()]));
    const originCounts = { instagram: 0, threads: 0, site: 0, telegram: 0 };
    const keyCounts = new Map();
    const weakCounts = new Map();
    const waitingAll = [];
    const waitlistCounts = new Map();

    for (const [id, sub] of активные) {
      const f = sub.funnel && typeof sub.funnel === "object" ? sub.funnel : null;
      const startedInWindow = f ? inWindow(f.startedAt, startMs, endMs) : inWindow(sub.subscribedAt, startMs, endMs);

      if (f) {
        for (const k of STAGE_KEYS) {
          if (!inWindow(f[k], startMs, endMs)) continue;
          // Отменённая заявка (lead.status "cancelled") не считается «заявкой» в воронке.
          if (k === "leadAt" && sub.lead?.status === "cancelled") continue;
          stageSets[k].add(id);
        }
      } else if (startedInWindow) {
        // Старая запись без funnel: «пришли» — единственный шаг, который можно взять
        // напрямую из subscribedAt. Середина воронки для такой записи не восстанавливается.
        stageSets.startedAt.add(id);
      }

      if (startedInWindow) {
        const origin = Object.prototype.hasOwnProperty.call(originCounts, sub.entryOrigin) ? sub.entryOrigin : "telegram";
        originCounts[origin]++;
        const key = sub.entryKey || legacyKeyFrom(sub);
        if (key) keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
      }

      // Записи в лист ожидания миссий (subscriber.waitlist = { key, role, people, when, at }).
      if (sub.waitlist?.key && inWindow(sub.waitlist.at, startMs, endMs)) {
        waitlistCounts.set(sub.waitlist.key, (waitlistCounts.get(sub.waitlist.key) || 0) + 1);
      }

      // Что болит — окно отдельное (7 дней по умолчанию), считается по всем активным,
      // не только по попавшим в сегодняшнее окно отчёта.
      const weak = sub?.diag?.итог?.weak;
      if (Array.isArray(weak) && weak.length) {
        const when = f?.diagDoneAt || sub.updatedAt;
        if (inWindow(when, weakStartMs, endMs)) {
          for (const echo of weak) {
            const t = typeof echo === "string" ? echo.trim() : "";
            if (t) weakCounts.set(t, (weakCounts.get(t) || 0) + 1);
          }
        }
      }

      // Ждут ответа — снимок «сейчас», не привязан к окну отчёта: карточка могла
      // повиснуть и позавчера, владелец/Алёна должны всё равно её увидеть.
      const card = sub?.salesCard;
      if (card && (card.status === "lead" || card.status === "diag") && !card.takenBy && !card.rejectedBy) {
        if (card.status === "lead" && sub.lead?.status === "cancelled") continue;
        const when = card.status === "lead" ? f?.leadAt : f?.diagDoneAt;
        waitingAll.push({
          id,
          name: displayName(sub),
          status: card.status,
          ageHours: hoursAgo(when || sub.updatedAt, now),
          link: cardLink(notifyChatId, card.messageId),
        });
      }
    }

    // Легаси-подстраховка: события/лиды за окно, которых ещё нет в funnel (или чьей
    // записи подписчика вообще нет — самый первый апдейт до первого upsertSubscriber).
    const events = await readJsonl(path.join(storageDir, "tg-events.jsonl"));
    for (const e of events) {
      if (!inWindow(e?.at, startMs, endMs)) continue;
      const ev = e.event || {};
      const from = ev.message?.from || ev.callback_query?.from;
      const chat = ev.message?.chat || ev.callback_query?.message?.chat;
      if (!from?.id || from.is_bot) continue;
      if (chat?.type && chat.type !== "private") continue;
      const id = String(from.id);
      if (excludeIds.has(id) || subsById.get(id)?.isTest) continue;
      stageSets.startedAt.add(id);
    }

    const leads = await readJsonl(path.join(storageDir, "leads.jsonl"));
    for (const l of leads) {
      if (!inWindow(l?.createdAt || l?.at, startMs, endMs)) continue;
      const tid = l?.telegramId != null ? String(l.telegramId) : undefined;
      if (tid && (excludeIds.has(tid) || subsById.get(tid)?.isTest)) continue;
      if (tid && stageSets.leadAt.has(tid)) continue; // уже учтён через funnel.leadAt
      stageSets.leadAt.add(`legacy:${tid || l.id || Math.random()}`);
    }

    const funnel = Object.fromEntries(STAGE_KEYS.map((k) => [k, stageSets[k].size]));
    const funnelByLabel = {
      started: funnel.startedAt,
      consent: funnel.consentAt,
      material: funnel.materialAt,
      diagStarted: funnel.diagStartedAt,
      diagDone: funnel.diagDoneAt,
      lead: funnel.leadAt,
    };

    const topKeys = topEntries(keyCounts, 5).map(([key, count]) => ({ key, count }));
    const weakTop = topEntries(weakCounts, 3).map(([text, count]) => ({ text, count }));
    // Сначала заявки (🔥 lead), потом диагностики (🟡 diag); внутри группы дольше
    // ждущие — выше (их нужно закрыть в первую очередь).
    const порядокСтатуса = { lead: 0, diag: 1 };
    waitingAll.sort((a, b) => {
      const поГруппе = (порядокСтатуса[a.status] ?? 99) - (порядокСтатуса[b.status] ?? 99);
      return поГруппе !== 0 ? поГруппе : b.ageHours - a.ageHours;
    });

    // --- Рендер ---
    const titleLine = bold(`${labels.titlePrefix}, ${moscowDate(now)}`);

    const funnelLine = STAGE_KEYS.map((k, i) => {
      const label = i === 0 ? капитализировать(labels.funnelSteps[i]) : labels.funnelSteps[i];
      return `${label} ${funnel[k]}`;
    }).join(" → ");

    const sourceCountsLine = `${labels.sourceNames.instagram} ${originCounts.instagram} · ${labels.sourceNames.threads || "Threads"} ${originCounts.threads} · ${labels.sourceNames.site} ${originCounts.site} · ${labels.sourceNames.telegram} ${originCounts.telegram}`;
    const waitlistLines = [...waitlistCounts.entries()]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]), "ru"))
      .map(([key, n]) => `${labels.waitlistPrefix} ${escapeHtml(keyLabels[key] || key)}: ${n}`);
    const keysLine = topKeys.length
      ? `${labels.keysPrefix}: ${topKeys.map((k) => `${escapeHtml(keyLabels[k.key] || k.key)} ${k.count}`).join(", ")}`
      : "";

    // Без длинных тире в пользовательском тексте (стиль проекта) — разделитель «·»,
    // ссылка на карточку — HTML-ссылкой на имени, не голым URL.
    const waitingShown = waitingAll.slice(0, 10);
    const waitingLines = waitingAll.length
      ? waitingShown
          .map((w) => {
            const emoji = labels.waitingEmoji[w.status] || "•";
            const age = formatAge(w.ageHours);
            const name = escapeHtml(w.name);
            const namePart = w.link ? `<a href="${escapeHtmlAttr(w.link)}">${name}</a>` : name;
            return `${emoji} ${namePart} · ${age}`;
          })
          .concat(waitingAll.length > 10 ? [labels.waitingMore(waitingAll.length - 10)] : [])
      : [labels.emptyLine];

    const weakLines = weakTop.length
      ? weakTop.map((w, i) => `${i + 1}. ${escapeHtml(w.text)} · ${w.count}`)
      : [labels.emptyLine];

    const text = [
      titleLine,
      "",
      bold(`${labels.funnelTitlePrefix} ${periodPhrase(hours)}`),
      funnelLine,
      "",
      bold(labels.sourceTitle),
      sourceCountsLine,
      ...(keysLine ? [keysLine] : []),
      ...waitlistLines,
      "",
      bold(labels.waitingTitle),
      ...waitingLines,
      "",
      bold(labels.weakTitle),
      ...weakLines,
    ].join("\n");

    // Владельцу — те же числа, ни одного имени/ника/телефона/ссылки на человека (D-014).
    const ownerSummary = [
      titleLine,
      "",
      bold(`${labels.funnelTitlePrefix} ${periodPhrase(hours)}`),
      funnelLine,
      "",
      bold(labels.sourceTitle),
      sourceCountsLine,
      ...waitlistLines,
      "",
      `${labels.waitingTitle}: ${waitingAll.length}`,
    ].join("\n");

    return {
      text,
      ownerSummary,
      counts: {
        funnel: funnelByLabel,
        bySource: { ...originCounts },
        topKeys,
        waiting: waitingAll.length,
        waitlist: Object.fromEntries(waitlistCounts),
        waitingList: waitingAll,
        weakTop,
      },
    };
  }

  return { build };
}
