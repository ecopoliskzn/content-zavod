// Бот для людей из соцсетей: выдаёт материал по ссылке и принимает заявку.
//
// ЗАЧЕМ ОН, ЕСЛИ ЕСТЬ САЙТ. У каждой площадки своя ссылка в бота с меткой
// (start=vk-priemka, start=yt-rashod). По меткам видно, какой канал привёл человека и
// что он попросил, даже когда счётчики сайта недоступны.
//
// ПОРЯДОК ЗАЯВКИ (каждый шаг проверен на живой воронке другого нашего бота):
//   1. человек пришёл по ссылке, получил материал сразу, без условий и подписок;
//   2. под материалом кнопка «Обсудить мой объект»;
//   3. один вопрос кнопками: что нужно;
//   4. согласие на обработку персональных данных — ПОСЛЕДНИМ шагом заявки и отдельным
//      сообщением. Согласие первым экраном бота отсекает людей до того, как они увидели
//      пользу; согласие, спрятанное в общий текст, с 01.09.2025 не считается согласием;
//   5. заявка сохраняется сразу после «Даю согласие»: связь через Telegram уже есть.
//      Телефон спрашиваем после, он необязателен и дописывается в готовую заявку;
//   6. согласие на рассылку — отдельный вопрос после заявки. Без него бот пишет
//      человеку, только когда тот написал сам.
//
// /stop отзывает оба согласия и сразу удаляет данные человека с сервера. Это право
// человека, и оно обязано работать одной командой.
//
// ЧТО ЗАПИСЫВАЕМ ДО СОГЛАСИЯ. Только метку входа и шаги воронки. Текст сообщения
// сохраняется в одном случае: человек сам задал вопрос, и его нужно передать специалисту.

import { config } from "../lib/config.mjs";
import { dataPath, env } from "../lib/env.mjs";
import { appendJsonl } from "../lib/files.mjs";
import { h } from "../lib/notify.mjs";
import { answerCallback, keyboard, sendMessage, tg } from "../lib/telegram.mjs";
import { legalReady } from "../leads/legal.mjs";
import { bot } from "./instance.mjs";
import { announceLead, relayQuestion, updateLeadCard, withdraw } from "./leads.mjs";

/**
 * Пока тексты согласий не утверждены юристом клиента, бот людям не отвечает по существу и
 * ничего о них не записывает: одна фраза и адрес блога. См. src/leads/legal.mjs.
 */
const notReady = (chatId) => sendMessage(chatId, t("notReady", { blogUrl: config().client.blog || config().client.site }));

const PLATFORMS = ["ig", "vk", "th", "yt", "rt", "dz", "tg", "site"];
const CHANNEL_TITLE = { ig: "Instagram", vk: "ВКонтакте", th: "Threads", yt: "YouTube", rt: "Rutube", dz: "Дзен", tg: "Telegram-канал", site: "сайт", direct: "прямой заход" };
const NEEDS = { pokrytie: "Покрытие для площадки", materialy: "Материалы и оборудование", obuchenie: "Обучение и франшиза", drugoe: "Другое" };

/** Адрес документа: свой адрес из окружения либо страница /doc на заводе. */
function docUrl(envName, page) {
  const direct = env(envName);
  if (/^https?:\/\//.test(direct)) return direct;
  const base = env("PUBLIC_BASE_URL").replace(/\/+$/, "");
  return base ? `${base}${direct || `/doc/${page}`}` : "";
}

/** Текст бота по ключу из bot/texts.json с подстановкой {плейсхолдеров}. */
const t = (key, vars = {}) => bot().telegram.texts.render(key, { consentUrl: docUrl("CONSENT_URL", "soglasie"), policyUrl: docUrl("POLICY_URL", "politika"), adsUrl: docUrl("ADS_CONSENT_URL", "soglasie-na-rassylku"), ...vars }) ?? key;
const consentLog = (row) => appendJsonl(dataPath("leads", "consents.jsonl"), { at: new Date().toISOString(), ...row });
const name = (from) => [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || "";

/** Ссылка на материал через наш счётчик переходов: видно, сколько людей дошло до сайта. */
function goLink(material, channel) {
  const base = env("PUBLIC_BASE_URL");
  if (!base || !material.goSlug) return material.articleUrl;
  return `${base.replace(/\/+$/, "")}/go/${material.goSlug}?c=bot-${channel || "direct"}`;
}

async function sendMaterial(chatId, material, channel) {
  const lines = [`<b>${h(material.title)}</b>`, "", h(material.teaser || "")];
  if (material.summary?.length) lines.push("", ...material.summary.map((s) => `• ${h(s)}`));
  if (material.note) lines.push("", `<i>${h(material.note)}</i>`);
  const rows = [];
  if (material.articleUrl) rows.push([{ text: material.button || "Открыть полностью", url: goLink(material, channel) }]);
  rows.push([{ text: t("btnLead"), data: "c:lead" }]);
  await sendMessage(chatId, lines.join("\n"), keyboard(rows));
}

async function menu(chatId, intro) {
  const b = bot();
  const rows = (b.materials || []).filter((m) => m.listed !== false).map((m) => [{ text: m.menu || m.title, data: `c:m:${m.key}` }]);
  rows.push([{ text: t("btnLead"), data: "c:lead" }]);
  await sendMessage(chatId, intro || t("welcome"), keyboard(rows));
}

async function askAds(chatId, sub) {
  if (sub.adsAsked) return;
  await bot().telegram.store.upsertSubscriber(String(chatId), { adsAsked: true });
  await sendMessage(chatId, t("consentAds"), keyboard([[{ text: t("btnAdsYes"), data: "c:ads:yes" }, { text: t("btnAdsNo"), data: "c:ads:no" }]]));
}

/** Сообщение из личного чата с ботом. */
export async function handleMessage(message) {
  const b = bot();
  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const text = String(message.text || "").trim();

  if (/^\/stop\b/i.test(text)) {
    // Отзыв пишется в журнал согласий, только если о человеке есть хоть что-то. Иначе
    // команда /stop от случайного прохожего сама создавала бы запись с его номером
    // Telegram: первую и единственную, которая у завода о нём есть.
    const known = await b.telegram.store.findSubscriber(userId).catch(() => null);
    if (known) {
      consentLog({ user: userId, kind: "pd", action: "withdrawn", how: "/stop" });
      consentLog({ user: userId, kind: "ads", action: "withdrawn", how: "/stop" });
    }
    // Удаление идёт всегда: оно ничего не пишет, если удалять нечего. Данные убираются
    // сразу, карточка заявки в группе очищается, сотрудники получают просьбу удалить
    // контакты у себя.
    await withdraw(userId, "/stop").catch((e) => console.error("[customer] удаление данных по /stop не прошло:", e?.message || e));
    await sendMessage(chatId, t("stopped"), { reply_markup: { remove_keyboard: true } });
    return;
  }

  // Отзыв согласия выше работает всегда. Всё остальное ждёт утверждённых текстов согласий.
  if (!legalReady()) { await notReady(chatId); return; }

  const entry = b.telegram.parseEntry(text, { платформы: PLATFORMS });
  if (entry) {
    const channel = entry["канал"] || (entry.key.includes("-") ? entry.key.split("-")[0] : "direct");
    await b.telegram.store.logEvent({ kind: "entry", from: userId, key: entry.key.replace(/-\d{10,}$/, "") });
    await b.telegram.store.upsertSubscriber(userId, {
      status: "active", tags: [`вход-${entry.key}`], entryOrigin: PLATFORMS.includes(channel) ? channel : "direct",
      funnel: { entered: new Date().toISOString() },
    });
    const material = entry.material ? b.materialByEntry(entry.material) : null;
    if (material) {
      await b.telegram.store.upsertSubscriber(userId, { funnel: { material: new Date().toISOString() }, lastMaterial: material.key });
      await sendMaterial(chatId, material, channel);
    } else {
      await menu(chatId);
    }
    return;
  }

  const sub = (await b.telegram.store.findSubscriber(userId)) || {};

  // Телефон после заявки: контактом, текстом или отказ кнопкой.
  if (sub.leadStep === "phone") {
    if (text === t("btnLeadNoPhone")) {
      await b.telegram.store.upsertSubscriber(userId, { leadStep: "" });
      await tg("sendMessage", { chat_id: chatId, text: t("phoneSkipped"), reply_markup: { remove_keyboard: true } });
      await askAds(chatId, sub);
      return;
    }
    const phone = message.contact?.phone_number || (text.match(/[+\d][\d\s()-]{9,}/) || [])[0];
    if (phone && sub.pdConsent) {
      const clean = phone.replace(/[^\d+]/g, "");
      await b.telegram.store.upsertSubscriber(userId, { phone: clean, leadStep: "" });
      await updateLeadCard(userId, { phone: clean });
      await tg("sendMessage", { chat_id: chatId, text: t("phoneSaved"), reply_markup: { remove_keyboard: true } });
      await askAds(chatId, sub);
      return;
    }
  }

  // Свободный текст: вопрос человеку из команды. Сами на него не отвечаем.
  if (text && !text.startsWith("/")) {
    await b.telegram.store.logEvent({ kind: "message", from: userId, text: text.slice(0, 300) });
    await relayQuestion(message, sub);
    await sendMessage(chatId, t("questionRelayed"));
    return;
  }
  await menu(chatId, t("unknown"));
}

/** Нажатие кнопки в личном чате. Возвращает true, если нажатие наше (c:…). */
export async function handleCallback(cb) {
  const data = String(cb.data || "");
  if (!data.startsWith("c:")) return false;
  const b = bot();
  const chatId = cb.message?.chat?.id ?? cb.from.id;
  const userId = String(cb.from.id);
  await answerCallback(cb.id);
  if (!legalReady()) { await notReady(chatId); return true; }
  const sub = (await b.telegram.store.findSubscriber(userId)) || {};

  if (data.startsWith("c:m:")) {
    const material = b.materialByEntry(data.slice(4));
    if (material) {
      await b.telegram.store.upsertSubscriber(userId, { funnel: { material: new Date().toISOString() }, lastMaterial: material.key });
      await sendMaterial(chatId, material, sub.entryOrigin);
    }
    return true;
  }

  if (data === "c:lead") {
    await b.telegram.store.upsertSubscriber(userId, { funnel: { leadStart: new Date().toISOString() } });
    await sendMessage(chatId, t("leadAskNeed"), keyboard(Object.entries(NEEDS).map(([k, title]) => [{ text: title, data: `c:need:${k}` }])));
    return true;
  }

  if (data.startsWith("c:need:")) {
    const need = data.slice(7);
    if (!NEEDS[need]) return true;
    await b.telegram.store.upsertSubscriber(userId, { leadNeed: need });
    // Согласие — последним шагом и отдельным сообщением. Полный текст и ссылка внутри.
    await sendMessage(chatId, t("consentPd", { need: NEEDS[need] }), keyboard([[{ text: t("btnPdYes"), data: "c:pd:yes" }, { text: t("btnPdNo"), data: "c:pd:no" }]]));
    return true;
  }

  if (data === "c:pd:no") {
    await sendMessage(chatId, t("consentPdDeclined"));
    return true;
  }

  if (data === "c:pd:yes") {
    if (sub.leadSavedAt && Date.now() - Date.parse(sub.leadSavedAt) < 24 * 3600_000) {
      await sendMessage(chatId, t("leadAlreadySaved"));
      return true;
    }
    const now = new Date().toISOString();
    consentLog({ user: userId, kind: "pd", action: "given", version: b.consentVersion, how: "кнопка в боте" });
    const origin = sub.entryOrigin || "direct";
    const lastTag = (b.telegram.store["последнийВход"](sub) || "").replace(/-\d{10,}$/, "");
    // Сначала запись на сервере, потом всё остальное: заявка не должна зависеть от сети.
    const { lead } = await b.leads.submitLead({
      source: b.sourceTag(origin),
      sourceLabel: `${CHANNEL_TITLE[origin] || origin}${lastTag ? ` · метка ${lastTag}` : ""}`,
      tgUserId: userId,
      name: name(cb.from),
      username: cb.from.username || "",
      need: sub.leadNeed || "drugoe",
      needTitle: NEEDS[sub.leadNeed] || NEEDS.drugoe,
      material: sub.lastMaterial || "",
      consent: { version: b.consentVersion, at: now },
    });
    // Имя появляется в записи бота только здесь, после согласия.
    await b.telegram.store.upsertSubscriber(userId, { firstName: cb.from.first_name, lastName: cb.from.last_name, username: cb.from.username, pdConsent: true, leadSavedAt: now, leadId: lead.id, leadStep: "phone", funnel: { lead: now } });
    await announceLead(lead, sub);
    await sendMessage(chatId, t("leadSaved"));
    await tg("sendMessage", {
      chat_id: chatId, text: t("leadAskPhone"),
      reply_markup: { keyboard: [[{ text: t("btnContactShare"), request_contact: true }], [{ text: t("btnLeadNoPhone") }]], resize_keyboard: true, one_time_keyboard: true },
    });
    return true;
  }

  if (data === "c:ads:yes" || data === "c:ads:no") {
    const yes = data.endsWith("yes");
    await b.telegram.store.upsertSubscriber(userId, { adsConsent: yes });
    consentLog({ user: userId, kind: "ads", action: yes ? "given" : "declined", version: b.consentVersion, how: "кнопка в боте" });
    await sendMessage(chatId, t(yes ? "consentAdsYes" : "consentAdsNo"));
    return true;
  }
  return true;
}
