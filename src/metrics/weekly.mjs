#!/usr/bin/env node
// Недельный отчёт. Cron на сервере, понедельник 09:00 по Москве:
//   0 6 * * 1 node /opt/ecopolis-zavod/current/src/metrics/weekly.mjs --send
//
// ПОРЯДОК ОТЧЁТА (читают его с телефона и до конца доходят редко):
//   1. заявки: сколько и откуда. Это то, ради чего завод работает;
//   2. что сработало: три поста с цифрой «во сколько раз выше обычного»;
//   3. что меняем на следующей неделе: не больше трёх пунктов, у каждого своя цифра.
// Всё остальное (площадки, слоты, кодовые слова) лежит ниже и в файле отчёта.
//
// Файл отчёта (reports/weekly/<понедельник>.md) читает сессия разбора S5: по нему она
// предлагает изменения в сетке и банке тем. Персональных данных в отчёте нет.
//
//   node src/metrics/weekly.mjs                 напечатать отчёт за прошлую неделю
//   node src/metrics/weekly.mjs --send          отправить в рабочую группу и сохранить файл
//   node src/metrics/weekly.mjs --week=2026-10-05

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../lib/config.mjs";
import { PROJECT_ROOT, dataPath } from "../lib/env.mjs";
import { readJsonl } from "../lib/files.mjs";
import { h, report } from "../lib/notify.mjs";
import { lastWeek, summarize } from "./summary.mjs";

const flag = (name) => process.argv.includes(`--${name}`);
const opt = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3);

const n = (x) => (Number.isFinite(x) ? String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") : "не измерено");
const times = (x) => `${x.toFixed(1).replace(".", ",")}×`;
const plural = (count, one, few, many) => { const a = Math.abs(count) % 100; const b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };

/** Сообщение в группу: коротко, главное сверху. */
export function telegramText(s, titles) {
  const t = (c) => titles[c] || c;
  const rows = [`<b>Неделя с ${s.week.slice(8, 10)}.${s.week.slice(5, 7)}: заявок ${s.leads.total}, вышло ${s.posts} ${plural(s.posts, "материал", "материала", "материалов")}</b>`];
  if (s.leads.total) {
    rows.push(Object.entries(s.leads.bySource).sort((a, b) => b[1] - a[1]).map(([c, k]) => `${h(t(c))} ${k}`).join(" · "));
    if (s.leads.unanswered) rows.push(`⚠️ Без ответа осталось: ${s.leads.unanswered}.`);
  } else {
    rows.push(`Заявок не было. Переходов на сайт: ${s.clicks.total}.`);
  }
  if (s.top.length) {
    rows.push("", "<b>Что сработало</b>");
    for (const p of s.top.slice(0, 3)) rows.push(`· ${h(t(p.channel))}: «${h(p.name)}» — ${n(p.views)} просмотров${p.ratio ? `, ${times(p.ratio)} от обычного` : ""}${p.link ? ` · <a href="${h(p.link)}">открыть</a>` : ""}`);
  }
  if (s.suggestions.length) {
    rows.push("", "<b>Что меняем на этой неделе</b>");
    s.suggestions.forEach((x, i) => rows.push(`${i + 1}. ${h(x)}`));
  }
  const quiet = Object.values(s.channels).filter((c) => c.posts === 0).map((c) => c.title);
  if (quiet.length) rows.push("", `Молчали: ${h(quiet.join(", "))}.`);
  rows.push("", "<i>Полный отчёт лежит у оператора: площадки, слоты, кодовые слова.</i>");
  return rows.join("\n");
}

/** Файл отчёта: всё, что посчитано. */
export function markdown(s, titles) {
  const t = (c) => titles[c] || c;
  const L = [`# Неделя с ${s.week}`, "", `Вышло материалов: ${s.posts}, из них с цифрами: ${s.measured}.`, ""];
  L.push("## Заявки", "", `Всего: **${s.leads.total}**. Взято в работу: ${s.leads.taken}, не целевых: ${s.leads.rejected}, без ответа: ${s.leads.unanswered}.`, "");
  if (s.leads.total) {
    L.push("| Площадка | Заявок |", "|---|---|", ...Object.entries(s.leads.bySource).sort((a, b) => b[1] - a[1]).map(([c, k]) => `| ${t(c)} | ${k} |`), "");
    L.push("| Что просили | Заявок |", "|---|---|", ...Object.entries(s.leads.byNeed).sort((a, b) => b[1] - a[1]).map(([c, k]) => `| ${c} | ${k} |`), "");
  }
  L.push("## Переходы на сайт", "", `Всего: ${s.clicks.total}, разных посетителей: ${s.clicks.unique}. Считает наш счётчик ссылок, роботы превью не учитываются.`, "");
  if (s.clicks.total) L.push("| Метка | Переходов |", "|---|---|", ...Object.entries(s.clicks.byChannel).sort((a, b) => b[1] - a[1]).map(([c, k]) => `| ${c} | ${k} |`), "");
  L.push("## Кодовые слова Instagram", "");
  L.push(Object.keys(s.keywords).length ? Object.entries(s.keywords).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`).join("\n") : "За неделю слова не срабатывали.", "");
  L.push("## Площадки", "", "| Площадка | Вышло | Просмотров | Медиана недели | Обычная медиана | Подписчики |", "|---|---|---|---|---|---|");
  for (const c of Object.values(s.channels)) {
    const f = s.followers[c.channel];
    L.push(`| ${c.title} | ${c.posts} | ${c.measured ? n(c.views) : "не измерено"} | ${c.measured ? n(c.median) : "—"} | ${c.usual ? n(c.usual) : "—"} | ${f ? `${n(f.now)} (${f.delta >= 0 ? "+" : ""}${f.delta})` : "—"} |`);
  }
  L.push("", "## Лучшие", "");
  for (const p of s.top) L.push(`- ${t(p.channel)} · ${p.slot} · «${p.name}» · ${n(p.views)} просмотров · ${p.ratio ? times(p.ratio) : "нет базы"} · материал: ${p.material || "—"}${p.link ? ` · ${p.link}` : ""}`);
  if (s.bottom.length) {
    L.push("", "## Слабые", "");
    for (const p of s.bottom) L.push(`- ${t(p.channel)} · ${p.slot} · «${p.name}» · ${n(p.views)} просмотров · ${p.ratio ? times(p.ratio) : "нет базы"} · материал: ${p.material || "—"}`);
  }
  L.push("", "## Материалы на нескольких площадках", "");
  for (const m of s.materials.slice(0, 10)) L.push(`- ${m.material}: ${[...new Set(m.channels)].map(t).join(", ")} · ${n(m.views)} просмотров · в среднем ${times(m.ratio)}`);
  L.push("", "## Слоты (медиана за восемь недель)", "");
  for (const [c, rows] of Object.entries(s.slots)) L.push(`- ${t(c)}: ${rows.map((r) => `${r.time} → ${n(r.median)} (${r.posts})`).join(" · ")}`);
  L.push("", "## Предложения", "");
  L.push(s.suggestions.length ? s.suggestions.map((x, i) => `${i + 1}. ${x}`).join("\n") : "Данных для предложений пока мало: нужно хотя бы по три выхода на слот.", "");
  return L.join("\n");
}

export function build(now = Date.now(), weekLabel = "") {
  const window = weekLabel ? { from: Date.parse(`${weekLabel}T00:00:00+03:00`), to: Date.parse(`${weekLabel}T00:00:00+03:00`) + 7 * 86_400_000, label: weekLabel } : lastWeek(now);
  const cfg = config();
  const titles = Object.fromEntries(Object.entries(cfg.channels).map(([k, v]) => [k, v.title]));
  for (const [k, v] of Object.entries({ ig: "Instagram", vk: "ВКонтакте", th: "Threads", yt: "YouTube", rt: "Rutube", dz: "Дзен", tg: "Telegram-канал", site: "сайт", direct: "прямой заход" })) titles[k] ||= v;
  const ledger = readJsonl(dataPath("ledger.jsonl"));
  const active = [...new Set(ledger.filter((r) => r.status === "published" && Date.parse(r.at) >= window.to - 56 * 86_400_000 && Date.parse(r.at) < window.to).map((r) => r.channel))];
  const summary = summarize({
    ledger,
    metrics: readJsonl(dataPath("metrics.jsonl")),
    followers: readJsonl(dataPath("followers.jsonl")),
    clicks: readJsonl(dataPath("go-clicks.jsonl")),
    leads: readJsonl(dataPath("leads", "leads.jsonl")),
    leadCards: readJsonl(dataPath("leads", "lead-cards.jsonl")),
    keywords: readJsonl(dataPath("leads", "ig-sent.jsonl")),
    window,
    channelTitles: titles,
    activeChannels: active,
  });
  return { summary, titles };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { summary, titles } = build(Date.now(), opt("week"));
    const md = markdown(summary, titles);
    if (flag("send")) {
      // Отчёт лежит в каталоге данных: он переживает выкладку кода и уезжает в дубль на
      // компьютер оператора вместе с журналами.
      const file = path.join(dataPath("reports", "weekly"), `${summary.week}.md`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, md, "utf8");
      writeFileSync(path.join(dataPath("reports", "weekly"), `${summary.week}.json`), JSON.stringify(summary, null, 1), "utf8");
      const sent = await report(telegramText(summary, titles));
      console.log(`${new Date().toISOString()} отчёт за неделю ${summary.week}: ${sent.ok ? "отправлен" : `не ушёл (${sent.error})`}, файл ${path.relative(PROJECT_ROOT, file)}`);
      if (!sent.ok) process.exitCode = 2;
    } else {
      console.log(md);
    }
  } catch (e) {
    console.error(`сбой отчёта: ${e?.stack || e}`);
    process.exitCode = 2;
  }
}
