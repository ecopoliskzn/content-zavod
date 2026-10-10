#!/usr/bin/env node
// Сторож срока ответа на заявку. Cron на сервере раз в полчаса в рабочие часы:
//   */30 6-17 * * 1-5 node /opt/ecopolis-zavod/current/src/leads/sla.mjs
//
// Заявка, которую никто не взял в работу дольше срока, попадает в ОДНУ сводку на все
// просроченные. Не сообщение на каждую: десять сообщений подряд группа перестаёт читать.
// Срок считается в рабочих часах клиента: заявка, пришедшая в пятницу вечером, в
// понедельник утром ещё не просрочена.
//
// В сводке нет телефонов и имён: только что просили, откуда человек и сколько ждёт.
// Кнопки и контакты лежат в самой карточке заявки выше в теме.
//
// Запуск руками:  node src/leads/sla.mjs [--dry]

import { fileURLToPath } from "node:url";
import { num } from "../lib/env.mjs";
import { alert, h, resolve } from "../lib/notify.mjs";
import { openLeads } from "../bot/leads.mjs";

const MSK = 3 * 3600_000;

/**
 * Сколько рабочих минут прошло между двумя моментами. Рабочее время: пн–пт,
 * с fromHour до toHour по Москве. Чистая функция.
 */
export function workMinutes(fromMs, toMs, fromHour = 8.5, toHour = 17.5) {
  if (!(toMs > fromMs)) return 0;
  let total = 0;
  // Идём по дням: заявки старше двух недель считать поминутно незачем.
  const end = Math.min(toMs, fromMs + 14 * 86_400_000);
  for (let dayStart = Math.floor((fromMs + MSK) / 86_400_000) * 86_400_000 - MSK; dayStart < end; dayStart += 86_400_000) {
    const weekday = new Date(dayStart + MSK).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const open = dayStart + fromHour * 3600_000;
    const close = dayStart + toHour * 3600_000;
    const a = Math.max(open, fromMs);
    const b = Math.min(close, end);
    if (b > a) total += (b - a) / 60_000;
  }
  return Math.round(total);
}

/** Просроченные заявки. Чистая функция: карточки и «сейчас» на вход. */
export function overdue(cards, now = Date.now(), limitMin = 60) {
  return cards
    .map((c) => ({ ...c, waitedMin: workMinutes(Date.parse(c.createdAt || c.at), now) }))
    .filter((c) => Number.isFinite(c.waitedMin) && c.waitedMin >= limitMin)
    .sort((a, b) => b.waitedMin - a.waitedMin);
}

const wait = (min) => (min >= 120 ? `${(min / 60).toFixed(1).replace(".", ",")} раб. ч` : `${min} раб. мин`);

export async function run({ dry = false, now = Date.now() } = {}) {
  const late = overdue(openLeads(), now, num("LEAD_SLA_MIN", 60));
  if (!late.length) {
    if (!dry) resolve("leads:sla");
    return { late: 0 };
  }
  const rows = late.slice(0, 10).map((c) => `· ${h(c.needTitle || "без уточнения")} · ${h(c.sourceLabel || c.source || "источник не определён")} · ждёт ${wait(c.waitedMin)}`);
  const text = `<b>Заявки без ответа: ${late.length}</b>\n${rows.join("\n")}${late.length > 10 ? `\n…и ещё ${late.length - 10}` : ""}`;
  if (dry) { console.log(text.replace(/<[^>]+>/g, "")); return { late: late.length }; }
  // Ключ тревоги не зависит от состава: одна сводка раз в шесть часов, пока заявки висят.
  await alert("leads:sla", text, { action: "откройте тему «Заявки» в этой группе и нажмите «Взял в работу» под карточкой. Не ваша заявка — «Не целевая»" });
  return { late: late.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run({ dry: process.argv.includes("--dry") }).then(
    (r) => { if (r.late) console.log(`${new Date().toISOString()} заявок без ответа: ${r.late}`); },
    (e) => { console.error(`сбой сторожа заявок: ${e?.stack || e}`); process.exitCode = 2; },
  );
}
