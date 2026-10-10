// Форма заявки на своём адресе: /z/<слаг>.
//
// ЗАЧЕМ СВОЯ ФОРМА, ЕСЛИ НА САЙТЕ КЛИЕНТА ЕСТЬ СВОИ.
//  1. Персональные данные. Имя и телефон человека первично записываются в базу на
//     сервере в России (требование 152-ФЗ о локализации). Сбор телефона перепиской в
//     зарубежной соцсети такой гарантии не даёт, поэтому из соцсетей ведём сюда.
//  2. Источник. У формы сайта метку канала ведёт чужой подрядчик. Здесь заявка сразу
//     знает площадку и пост, с которых человек пришёл.
//  3. Согласие. С 01.09.2025 согласие на обработку оформляется отдельно от прочих
//     условий: у формы две НЕ отмеченные заранее галочки, на обработку и на рассылку,
//     и у каждой своя ссылка на полный текст.
//
// Защита: поле-ловушка для роботов, предел отправок с одного адреса, предел длины полей.
// Тексты форм лежат в bot/forms.json: правятся без программиста.

import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "../lib/config.mjs";
import { PROJECT_ROOT, dataPath, env } from "../lib/env.mjs";
import { appendJsonl, readJson } from "../lib/files.mjs";
import { bot } from "../bot/instance.mjs";
import { announceLead } from "../bot/leads.mjs";
import { legalReady } from "./legal.mjs";

const FORMS = path.join(PROJECT_ROOT, "bot", "forms.json");
const e = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const NEEDS = { pokrytie: "Покрытие для площадки", materialy: "Материалы и оборудование", obuchenie: "Обучение и франшиза", drugoe: "Другое" };

const hits = new Map();
function tooMany(key, limit = 5, windowMs = 10 * 60_000) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return list.length > limit;
}

function formCfg(slug) {
  const all = readJson(FORMS, {}) || {};
  return { ...(all.default || {}), ...(all[slug] || {}) };
}

const page = (title, body) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${e(title)}</title>
<style>body{font:17px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;background:#f5f6f4;color:#1c1f1a}main{max-width:560px;margin:0 auto;padding:28px 18px 60px}h1{font-size:26px;line-height:1.2;margin:8px 0 12px;text-wrap:balance}p{margin:0 0 14px}label{display:block;margin:16px 0 6px;font-weight:600}input[type=text],input[type=tel],textarea,select{width:100%;box-sizing:border-box;padding:13px 12px;font:inherit;border:1px solid #b9beb4;border-radius:8px;background:#fff}textarea{min-height:92px}.c{display:flex;gap:10px;align-items:flex-start;margin:16px 0;font-weight:400}.c input{margin-top:5px;width:20px;height:20px;flex:none}button{margin-top:10px;width:100%;padding:15px;font:inherit;font-weight:700;border:0;border-radius:8px;background:#1f6f43;color:#fff}.err{background:#fde8e6;border:1px solid #e0a39c;padding:12px;border-radius:8px}.s{font-size:14px;color:#565c52}.hp{position:absolute;left:-9999px}a{color:#1f6f43}</style></head><body><main>${body}</main></body></html>`;

/**
 * Страница вместо формы, пока тексты согласий не утверждены юристом клиента. Форма
 * открыта всему интернету с минуты, когда поднят сервер, поэтому заслон стоит здесь, а не
 * в памятке. См. src/leads/legal.mjs.
 */
export const closedPage = () => {
  const client = config().client;
  return page("Форма скоро заработает", `<p class="s">${e(client.name)}</p><h1>Форма скоро заработает</h1><p>Сейчас заявки принимаются на сайте компании.</p><p><a href="${e(client.site)}/contacts/">Контакты на сайте</a></p>`);
};

/** Страница формы. */
export function renderForm(slug, query = {}, error = "", values = {}) {
  if (!legalReady()) return closedPage();
  const cfg = formCfg(slug);
  const consent = env("CONSENT_URL", "/doc/soglasie");
  const policy = env("POLICY_URL", "/doc/politika");
  const ads = env("ADS_CONSENT_URL", "/doc/soglasie-na-rassylku");
  const client = config().client;
  const options = Object.entries(NEEDS).map(([k, t]) => `<option value="${k}"${(values.need || cfg.need) === k ? " selected" : ""}>${e(t)}</option>`).join("");
  return page(cfg.title || "Заявка", `
<p class="s">${e(client.name)}</p>
<h1>${e(cfg.title || "Обсудить объект")}</h1>
<p>${e(cfg.lead || "Оставьте контакт: специалист свяжется и ответит по делу.")}</p>
${error ? `<p class="err">${e(error)}</p>` : ""}
<form method="post" action="/z/${e(slug)}">
<input type="hidden" name="c" value="${e(query.c || values.c || "")}"><input type="hidden" name="p" value="${e(query.p || values.p || "")}">
<div class="hp" aria-hidden="true"><label>Сайт<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
<label for="n">Как к вам обращаться</label><input id="n" type="text" name="name" maxlength="80" required value="${e(values.name || "")}" autocomplete="name">
<label for="t">Телефон</label><input id="t" type="tel" name="phone" maxlength="24" required value="${e(values.phone || "")}" autocomplete="tel" inputmode="tel">
<label for="w">Что нужно</label><select id="w" name="need">${options}</select>
<label for="m">Коротко о задаче (необязательно)</label><textarea id="m" name="comment" maxlength="1000">${e(values.comment || "")}</textarea>
<label class="c"><input type="checkbox" name="consent_pd" value="1" required><span>Даю <a href="${e(consent)}" target="_blank" rel="noopener">согласие на обработку персональных данных</a> ${e(client.name)} (ИНН ${e(client.inn)}) для ответа на мою заявку. <a href="${e(policy)}" target="_blank" rel="noopener">Политика обработки</a>.</span></label>
<label class="c"><input type="checkbox" name="consent_ads" value="1"><span>Согласен получать <a href="${e(ads)}" target="_blank" rel="noopener">сообщения о материалах и предложениях</a> компании. Необязательно.</span></label>
<button type="submit">${e(cfg.button || "Отправить")}</button>
</form>`);
}

export const thanksPage = (slug) => {
  const cfg = formCfg(slug);
  return page("Заявка принята", `<h1>Заявка принята</h1><p>${e(cfg.thanks || "Специалист свяжется с вами в рабочее время.")}</p><p><a href="${e(config().client.site)}">На сайт компании</a></p>`);
};

/**
 * Приём формы. Возвращает { status, html }.
 * @param {string} slug
 * @param {URLSearchParams} body
 * @param {{ ip: string, ua: string }} who
 */
export async function submitForm(slug, body, who) {
  // Согласия не утверждены: заявку не принимаем и ничего из присланного не записываем.
  if (!legalReady()) return { status: 503, html: closedPage() };
  const v = Object.fromEntries(body);
  // Робот заполнил поле-ловушку: отвечаем как обычно, заявку не создаём.
  if (v.website) return { status: 200, html: thanksPage(slug) };
  const key = createHash("sha256").update(`${who.ip}|${who.ua}`).digest("hex").slice(0, 16);
  if (tooMany(key)) return { status: 429, html: renderForm(slug, {}, "Слишком много отправок подряд. Попробуйте через десять минут.", v) };
  const name = String(v.name || "").trim().slice(0, 80);
  const phone = String(v.phone || "").replace(/[^\d+]/g, "").slice(0, 16);
  if (name.length < 2) return { status: 400, html: renderForm(slug, {}, "Напишите, как к вам обращаться.", v) };
  if (phone.replace(/\D/g, "").length < 10) return { status: 400, html: renderForm(slug, {}, "Проверьте номер телефона: в нём должно быть не меньше десяти цифр.", v) };
  if (v.consent_pd !== "1") return { status: 400, html: renderForm(slug, {}, "Без согласия на обработку персональных данных заявку принять нельзя.", v) };

  const b = bot();
  const now = new Date().toISOString();
  const need = NEEDS[v.need] ? v.need : "drugoe";
  const channel = String(v.c || "site").replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || "site";
  // Сначала запись на сервере, потом уведомление: заявка не должна зависеть от сети.
  const { lead } = await b.leads.submitLead({
    source: b.sourceTag(channel),
    sourceLabel: `форма /z/${slug} · площадка ${channel}${v.p ? ` · запись ${String(v.p).slice(0, 32)}` : ""}`,
    name, phone, need, needTitle: NEEDS[need],
    comment: String(v.comment || "").trim().slice(0, 1000),
    consent: { version: b.consentVersion, at: now },
  });
  appendJsonl(dataPath("leads", "consents.jsonl"), { at: now, lead: lead.id, kind: "pd", action: "given", version: b.consentVersion, how: `форма /z/${slug}` });
  if (v.consent_ads === "1") appendJsonl(dataPath("leads", "consents.jsonl"), { at: now, lead: lead.id, kind: "ads", action: "given", version: b.consentVersion, how: `форма /z/${slug}` });
  await announceLead({ ...lead, comment: lead.comment }, { phone }).catch((err) => console.error("[form] карточка заявки не ушла:", err?.message || err));
  return { status: 200, html: thanksPage(slug) };
}
