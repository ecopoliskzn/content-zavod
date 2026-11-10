#!/usr/bin/env node
// Сбор комментариев под публикациями компании. Cron на сервере два раза в день:
//   0 5,12 * * * node /opt/ecopolis-zavod/current/src/comments/collect.mjs --send
//
// ЗАЧЕМ. Вопрос под роликом — это человек, который уже думает о покрытии. Ответ в тот же
// день превращает зрителя в заявку, молчание — в чужого клиента. А ещё каждый вопрос
// готовая тема: то, о чём спрашивают трое, стоит снять.
//
// ЧТО СБОРЩИК НЕ ДЕЛАЕТ. Не отвечает. Ответ пишет сессия S6 по образцу, согласует человек
// клиента (ответ компании — такая же публикация), а вставляет его сотрудник: ссылка на
// комментарий и готовый текст приходят ему в рабочую группу. Десять ответов, написанных
// и отправленных конвейером, читаются как конвейер.
//
// ЧТО ХРАНИМ. Текст комментария, площадку, время и ссылку. Имя и аккаунт автора не
// сохраняются: чтобы ответить, они не нужны, а ссылка ведёт прямо к комментарию.
//
// Откуда берём:
//   YouTube   — собственный OAuth: все страницы опубликованных веток и всех ответов.
//               Живой сбор разрешён только на российском сервере;
//   ВКонтакте — сервисный ключ: комментарии под записями последних трёх недель;
//   Rutube    — открытый JSON, ключ не нужен;
//   Instagram — те же вызовы, что у опроса кодовых слов;
//   Threads   — ответы под ветками последних семи дней. Раз в сутки, не чаще: частое
//               чтение обсуждений у нас однажды закрыло серверу доступ.
//
//   node src/comments/collect.mjs [--send] [--dry] [--only=youtube,vk]

import { isMain } from '../lib/is-main.mjs';
import { dataDir, dataPath, env } from "../lib/env.mjs";
import { appendJsonl, latestById, readJson, writeJson } from "../lib/files.mjs";
import { request, sleep } from "../lib/http.mjs";
import { readInstagramComments } from "./instagram.mjs";
import {intakeLock} from '../bot/media-intake-store.mjs';
import {readThreadsComments} from './threads.mjs';
import {flushCommentNotifications} from './notifications.mjs';
import { idFromLink as rutubeId } from "../channels/rutube.mjs";
import { rows as ledgerRows } from "../queue/ledger.mjs";
import { readYoutubeComments } from "./youtube.mjs";

const FILE = () => dataPath("comments.jsonl");
const flag = (name) => process.argv.includes(`--${name}`);
const opt = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3);
const TITLE = { youtube: "YouTube", vk: "ВКонтакте", rutube: "Rutube", instagram: "Instagram", threads: "Threads" };

/** Старые вопросы остаются в истории, но не появляются в списке новых. */
export function foundRow(item, now = Date.now()) {
  const old = now - Date.parse(item.at) > 21 * 86_400_000;
  return { ...item, text: item.text.slice(0, 1500), status: old ? 'archived' : 'new', foundAt: new Date(now).toISOString() };
}

export const all = () => [...latestById(FILE()).values()];
export const byStatus = (status) => all().filter((c) => c.status === status);

/** Сменить статус комментария: answered (ответили), skipped (ответ не нужен). */
export function setStatus(id, status, by = "") {
  const was = latestById(FILE()).get(String(id));
  if (!was) return false;
  appendJsonl(FILE(), { ...was, status, by, statusAt: new Date().toISOString() });
  return true;
}

/** Вышедшие за последние дни записи площадки: под ними ищем комментарии. */
function recent(channel, days) {
  const since = Date.now() - days * 86_400_000;
  const map = new Map();
  for (const r of ledgerRows()) {
    if (r.channel !== channel || !["published", "link"].includes(r.status)) continue;
    map.set(r.id, { ...(map.get(r.id) || {}), ...r });
  }
  return [...map.values()].filter((r) => Date.parse(r.at) >= since);
}

async function youtube() {
  return readYoutubeComments();
}

async function vk() {
  const token = env("VK_SERVICE_TOKEN");
  const group = env("VK_GROUP_ID").replace(/^-/, "");
  if (!token || !group) return { skipped: "нет VK_SERVICE_TOKEN или VK_GROUP_ID" };
  const items = [];
  for (const row of recent("vk", 21)) {
    const post = String(row.externalId || row.link || "").match(/-?\d+_(\d+)/)?.[1];
    if (!post) continue;
    const r = await request(`https://api.vk.ru/method/wall.getComments?owner_id=-${group}&post_id=${post}&count=100&sort=desc&v=5.199`, { headers: { authorization: `Bearer ${token}` }, retries: 1 });
    if (r.kind !== "ok") return items.length ? { items } : { error: r.error };
    for (const c of r.data?.response?.items || []) {
      if (c.from_id === -Number(group) || !c.text) continue;
      items.push({ id: `vk:${post}_${c.id}`, platform: "vk", at: new Date(c.date * 1000).toISOString(), text: String(c.text), link: `https://vk.com/wall-${group}_${post}?reply=${c.id}`, post: `-${group}_${post}` });
    }
    await sleep(400);
  }
  return { items };
}

async function rutube() {
  const items = [];
  for (const row of recent("rutube", 30)) {
    const id = /^[0-9a-f]{32}$/i.test(String(row.externalId)) ? row.externalId : rutubeId(row.link);
    if (!id) continue;
    const r = await request(`https://rutube.ru/api/comments/video/${id}/`, { headers: { accept: "application/json" }, retries: 0 });
    if (r.kind !== "ok") continue;
    for (const c of r.data?.results || []) {
      if (!c.text) continue;
      items.push({ id: `rutube:${c.id}`, platform: "rutube", at: c.created_ts || new Date().toISOString(), text: String(c.text), link: `https://rutube.ru/video/${id}/`, post: id });
    }
    await sleep(400);
  }
  return { items };
}

async function instagram() {
  return readInstagramComments();
}

export async function readScheduledThreads({dry=false,now=Date.now(),read=readThreadsComments}={}) {
  // Не чаще раза в сутки, что бы ни стояло в расписании.
  const state = readJson(dataPath("comments-state.json"), {}) || {};
  if (state.threadsAt && now - Date.parse(state.threadsAt) < 20 * 3600_000) return { skipped: "Threads читается раз в сутки" };
  if(state.threadsAttemptAt&&now-Date.parse(state.threadsAttemptAt)<30*60000)return{skipped:'Threads: ожидание после недавней попытки'};
  if(!dry)writeJson(dataPath('comments-state.json'),{...state,threadsAttemptAt:new Date(now).toISOString()});
  const result=await read();
  if(!dry&&result.coverage?.complete&&result.coverage.posts>0)writeJson(dataPath('comments-state.json'),{...state,threadsAttemptAt:new Date(now).toISOString(),threadsAt:new Date(now).toISOString()});
  return result;
}

const SOURCES = { youtube, vk, rutube, instagram, threads:readScheduledThreads };

/** Один проход сбора. Возвращает новые комментарии и что пропущено. */
export async function collect({ dry = false, only = [],sourceReaders=SOURCES,clock=Date.now } = {}) {
  // Даже --dry получает тексты людей по сети: на компьютере он не является безопасным
  // предпросмотром. Запрещаем живой сбор до чтения журнала и до первого запроса.
  if (sourceReaders===SOURCES&&!dataDir().startsWith('/opt/')) return { fresh: [], notes: ['живой сбор комментариев разрешён только на российском сервере'], failed: 0 };
  const known = latestById(FILE());
  const fresh = [];
  const notes = [];
  let failed = 0;
  const coverage = {};
  const completedSources = [], skippedSources = [];
  for (const [name, read] of Object.entries(sourceReaders)) {
    if (only.length && !only.includes(name)) continue;
    let res;
    try { res = await read({dry,now:clock()}); } catch { res = { error: 'внутренняя ошибка чтения; охват не подтверждён' }; }
    if (res.coverage) coverage[name] = res.coverage;
    if (res.skipped) { skippedSources.push(name); notes.push(`${TITLE[name]}: ${res.skipped}`); continue; }
    if (res.error) { failed++; notes.push(`${TITLE[name]}: не прочитан (${res.error})`); continue; }
    completedSources.push(name);
    for (const item of res.items || []) {
      if (known.has(item.id)) {
        const old = known.get(item.id);
        if (!dry && name === 'youtube' && (old.text !== item.text.slice(0, 1500) || old.replies !== item.replies)) {
          const updated = { ...old, ...item, text: item.text.slice(0, 1500), updatedAt: new Date().toISOString() };
          appendJsonl(FILE(), updated);
          known.set(item.id, updated);
        }
        continue;
      }
      // Старые ветки YouTube сохраняем для полноты истории, но не выдаём за новые
      // вопросы. Новый ответ под старой веткой сам проходит сюда по своей дате.
      const old = clock() - Date.parse(item.at) > 21 * 86_400_000;
      if (old && !['youtube','threads'].includes(name)) continue;
      const row = foundRow(item,clock());
      if (!old) fresh.push(row);
      known.set(row.id, row);
      if (!dry) appendJsonl(FILE(), row);
    }
  }
  if (!dry) {
    const before = readJson(dataPath('comments-health.json'), {}) || {};
    writeJson(dataPath('comments-health.json'), { ...before, lastAttemptAt: new Date().toISOString(), failed, completedSources, skippedSources, coverage,
      ...(completedSources.length && !failed ? { lastSuccessAt: new Date().toISOString() } : {}) });
  }
  return { fresh, notes, failed, coverage };
}

/** Сводка новых комментариев в рабочую группу: одним сообщением. */
export async function sendDigest(fresh=[]) {
  const registered=new Map(all().map(c=>[c.id,c]));for(const c of fresh)registered.set(c.id,c);
  const result=await flushCommentNotifications([...registered.values()]);return !result.failed&&!result.unknown;
}

if (isMain(import.meta.url)) {
  const dry = flag("dry");
  const only=opt('only')?opt('only').split(','):[];
  const unlock=intakeLock(dataPath('comments-collect.lock'));
  if(!unlock)console.log('Сбор комментариев уже выполняется.');
  else (flag('notify-only')?Promise.resolve({fresh:[],notes:[],failed:0}):collect({ dry,only })).then(
    async ({ fresh, notes, failed }) => {
      console.log(`${new Date().toISOString()} новых комментариев: ${fresh.length}${notes.length ? ` · ${notes.join("; ")}` : ""}`);
      if (!dry && flag("send")) {const delivery=await flushCommentNotifications(all(),{only});console.log('Сводки: '+JSON.stringify(delivery));if(delivery.failed||delivery.unknown)process.exitCode=2;}
      if (failed) process.exitCode = 2;
    },
    () => { console.error('Сбор комментариев не завершён; проверьте безопасные метаданные.'); process.exitCode = 2; },
  ).catch(()=>{console.error('Доставка сводки не завершена; неизвестный исход не повторяется вслепую.');process.exitCode=2;}).finally(unlock);
}
