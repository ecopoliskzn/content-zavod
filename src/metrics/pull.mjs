#!/usr/bin/env node
// Съём цифр по вышедшему. Cron на сервере раз в сутки:
//   10 4 * * * node /opt/ecopolis-zavod/current/src/metrics/pull.mjs
//
// Берёт из журнала выпусков всё вышедшее, спрашивает у площадок цифры и дописывает
// замер в data/metrics.jsonl. Замер — снимок на день: по ряду снимков видно, как пост
// набирал просмотры, а последний снимок идёт в недельный отчёт.
//
// КАК ЧАСТО. Раз в сутки, не чаще: частое чтение у нас однажды закрыло серверу доступ
// к Threads на несколько часов. Свежие посты (до двух недель) меряются каждый день,
// старые (до двух месяцев) только по понедельникам: после двух недель цифра почти стоит.
//
// СБОЙ ПЛОЩАДКИ НЕ ЛОМАЕТ СЪЁМ. Площадка не ответила — у её постов строка с ошибкой,
// остальные площадки меряются. Отсутствие цифры и ноль — разные вещи: в отчёте пост без
// замера помечается «не измерено», а не нулём.
// YouTube дополнительно снимается целиком: youtube/history/<день>.json. Его архив не
// ограничен журналом завода и возрастом ролика; описания и комментарии туда не входят.
//
// Запуск руками:  node src/metrics/pull.mjs [--channel=threads] [--days=14] [--dry]

import { isMain } from '../lib/is-main.mjs';
import { channelNames } from "../lib/config.mjs";
import { dataPath } from "../lib/env.mjs";
import { appendJsonl } from "../lib/files.mjs";
import { mskDate } from "../lib/time.mjs";
import { adapter } from "../channels/index.mjs";
import { rows as ledgerRows } from "../queue/ledger.mjs";
import { get } from "../queue/store.mjs";
import { collectHistory } from "./youtube-history.mjs";

const flag = (name) => process.argv.includes(`--${name}`);
const opt = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3);

/** Мерить ли пост сегодня. Чистая функция. */
export function dueToday(ageDays, weekday, maxDays = 60) {
  if (ageDays < 0 || ageDays > maxDays) return false;
  if (ageDays <= 14) return true;
  return weekday === 1; // понедельник
}

export async function pull({ now = Date.now(), only = "", days = 60, dry = false } = {}) {
  const weekday = new Date(now + 3 * 3600_000).getUTCDay();
  // Последняя строка журнала по записи: в ней номер публикации и ссылка.
  const lastById = new Map();
  const links = new Map();
  for (const r of ledgerRows()) {
    if (r.status === "published") lastById.set(r.id, { ...(lastById.get(r.id) || {}), ...r });
    // Ссылку на вручную выложенный материал человек присылает отдельным ответом,
    // иногда раньше, чем нажмёт «Выложено».
    else if (r.status === "link" && r.link) links.set(r.id, r.link);
  }
  const byChannel = new Map();
  for (const row of lastById.values()) {
    const r = { ...row, link: row.link || links.get(row.id) || "" };
    if (only && r.channel !== only) continue;
    const ageDays = (now - Date.parse(r.at)) / 86_400_000;
    if (!dueToday(Math.floor(ageDays), weekday, days)) continue;
    // Нет ни номера публикации, ни ссылки: цифры этой записи снять нечем.
    const key = r.externalId || r.link;
    if (!key) continue;
    if (!byChannel.has(r.channel)) byChannel.set(r.channel, []);
    byChannel.get(r.channel).push({ ...r, externalId: key, ageDays: Math.floor(ageDays) });
  }

  const out = { measured: 0, failed: 0, channels: {} };
  // Архив канала не ограничивается публикациями завода и возрастом ролика.
  if (!only || only === 'youtube') {
    try { out.youtubeArchive = await collectHistory({ now, dry }); }
    catch { out.youtubeArchive = { kind: 'network', error: 'история YouTube не записана' }; }
    if ((out.youtubeArchive.kind && out.youtubeArchive.kind !== 'ok') || (out.youtubeArchive.analyticsState && out.youtubeArchive.analyticsState !== 'ok')) out.failed++;
  }
  for (const [channel, items] of byChannel) {
    let mod;
    try { mod = await adapter(channel); } catch { continue; }
    if (typeof mod.metrics !== "function") continue;
    let rows;
    try {
      rows = await mod.metrics(items.map((i) => ({ externalId: i.externalId, link: i.link, ownReplies: Math.max(0, (get(i.id)?.done?.length || 1) - 1) })));
    } catch (e) {
      rows = items.map((i) => ({ externalId: i.externalId, error: `сбой адаптера: ${e?.message || e}`, kind: "network" }));
    }
    const byExternal = new Map(rows.map((r) => [String(r.externalId), r]));
    let ok = 0;
    for (const item of items) {
      const m = byExternal.get(String(item.externalId)) || { error: "площадка не вернула строку" };
      const { externalId: _drop, ...numbers } = m;
      if (!m.error) ok++;
      if (!dry) appendJsonl(dataPath("metrics.jsonl"), { at: new Date(now).toISOString(), day: mskDate(now), id: item.id, channel, name: item.name, material: item.material, slot: item.slot, publishedAt: item.at, externalId: item.externalId, ageDays: item.ageDays, ...numbers });
    }
    out.channels[channel] = { asked: items.length, ok };
    out.measured += ok;
    out.failed += items.length - ok;
  }

  // Подписчики площадок: по одному замеру в день.
  for (const channel of channelNames()) {
    if (only && channel !== only) continue;
    try {
      const mod = await adapter(channel);
      if (typeof mod.followers !== "function") continue;
      const count = await mod.followers();
      if (Number.isFinite(count) && !dry) appendJsonl(dataPath("followers.jsonl"), { at: new Date(now).toISOString(), day: mskDate(now), channel, count });
      if (Number.isFinite(count)) (out.channels[channel] ||= {}).followers = count;
    } catch { /* нет адаптера или ключа: площадка ещё не подключена */ }
  }
  return out;
}

if (isMain(import.meta.url)) {
  pull({ only: opt("channel"), days: Number(opt("days")) || 60, dry: flag("dry") }).then(
    (r) => {
      console.log(`${new Date().toISOString()} измерено ${r.measured}, без ответа ${r.failed} ${JSON.stringify(r.channels)}${r.youtubeArchive ? ` · архив YouTube ${JSON.stringify(r.youtubeArchive)}` : ''}`);
      if (r.failed) process.exitCode = 2;
    },
    (e) => { console.error(`сбой съёма цифр: ${e?.stack || e}`); process.exitCode = 2; },
  );
}
