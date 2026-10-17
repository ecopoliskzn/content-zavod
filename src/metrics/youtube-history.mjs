// Ежедневная история всего доступного владельцу архива, включая старые и закрытые
// ролики. Снимки дней неизменяемы; пропажа из описи означает утрату доступности,
// а не доказанное удаление. Сравнение считает прирост только общего измеренного набора.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { api, analytics } from '../channels/youtube.mjs';
import { dataPath, env, has } from '../lib/env.mjs';
import { lock, readJson, writeJson } from '../lib/files.mjs';
import { mskDate } from '../lib/time.mjs';

const fields = ['views', 'likes', 'comments'];
const number = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const historyDir = () => dataPath('youtube', 'history');
const valid = s => s?.version === 1 && s.complete === true && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s.day) && s.channelId && Array.isArray(s.list) && Number.isFinite(Date.parse(s.taken));

export async function fetchArchive({ channelId = env('YOUTUBE_CHANNEL_ID'), now = Date.now(), call = api, readAnalytics = analytics } = {}) {
  const ch = await call('channels?part=contentDetails,statistics,snippet&mine=true');
  if (ch.kind !== 'ok') return { kind: ch.kind, error: 'YouTube: канал не прочитан' };
  const c = ch.data?.items?.find(c => c.id === channelId);
  if (!c?.contentDetails?.relatedPlaylists?.uploads) return { kind: 'refused', error: 'YouTube: канал OAuth не совпадает с YOUTUBE_CHANNEL_ID или нет списка загрузок' };
  const ids = new Set(), pages = new Set();
  let page = '';
  do {
    if (pages.has(page)) return { kind: 'refused', error: 'YouTube: повтор страницы загрузок' };
    pages.add(page);
    const q = new URLSearchParams({ part: 'contentDetails', maxResults: '50', playlistId: c.contentDetails.relatedPlaylists.uploads, ...(page ? { pageToken: page } : {}) });
    const r = await call(`playlistItems?${q}`);
    if (r.kind !== 'ok' || !Array.isArray(r.data?.items)) return { kind: r.kind === 'ok' ? 'refused' : r.kind, error: 'YouTube: список загрузок прочитан не полностью' };
    for (const i of r.data.items) {
      if (!i.contentDetails?.videoId) return { kind: 'refused', error: 'YouTube: в списке загрузок нет номера видео' };
      ids.add(i.contentDetails.videoId);
    }
    page = r.data.nextPageToken || '';
  } while (page);
  const details = new Map(), allIds = [...ids];
  for (let offset = 0; offset < allIds.length; offset += 50) {
    const r = await call(`videos?${new URLSearchParams({ part: 'snippet,statistics,contentDetails,status', id: allIds.slice(offset, offset + 50).join(',') })}`);
    if (r.kind !== 'ok' || !Array.isArray(r.data?.items)) return { kind: r.kind === 'ok' ? 'refused' : r.kind, error: 'YouTube: сведения роликов прочитаны не полностью' };
    for (const v of r.data.items) details.set(v.id, v);
  }
  let a;
  try { a = allIds.length ? await readAnalytics(allIds) : { kind: 'ok', byId: new Map() }; }
  catch { a = { kind: 'network' }; }
  const list = allIds.map(id => {
    const v = details.get(id);
    if (!v) return { id, availability: 'unavailable', privacy: 'unknown', views: null, likes: null, comments: null };
    return { id, title: String(v.snippet?.title || ''), publishedAt: v.snippet?.publishedAt || null,
      availability: 'available', privacy: v.status?.privacyStatus || 'unknown', publishAt: v.status?.publishAt || null,
      uploadStatus: v.status?.uploadStatus || null, duration: v.contentDetails?.duration || null,
      views: number(v.statistics?.viewCount), likes: number(v.statistics?.likeCount), comments: number(v.statistics?.commentCount),
      analytics: a.kind === 'ok' ? (a.byId?.get(id) || null) : null };
  });
  return { kind: 'ok', snapshot: { version: 1, complete: true, source: 'YouTube Data API / owner OAuth', channelId: c.id,
    title: c.snippet?.title || '', day: mskDate(now), taken: new Date(now).toISOString(), subscribers: number(c.statistics?.subscriberCount),
    channelViews: number(c.statistics?.viewCount), channelVideoCount: number(c.statistics?.videoCount),
    analyticsUntil: a.until || null, analyticsState: a.kind, list } };
}

export function compareArchives(before, after) {
  if (!valid(before) || !valid(after) || before.channelId !== after.channelId) throw Error('Несопоставимые снимки YouTube');
  const old = new Map(before.list.map(v => [v.id, v])), current = new Map(after.list.map(v => [v.id, v]));
  const commonDelta = Object.fromEntries(fields.map(f => [f, 0]));
  const commonMeasured = Object.fromEntries(fields.map(f => [f, 0]));
  const statusChanges = [], videoDeltas = [];
  for (const [id, v] of current) {
    const b = old.get(id);
    if (!b) continue;
    const delta = {};
    for (const f of fields) if (Number.isFinite(b[f]) && Number.isFinite(v[f])) { delta[f] = v[f] - b[f]; commonDelta[f] += delta[f]; commonMeasured[f]++; }
    if ((b.privacy || 'unknown') !== (v.privacy || 'unknown')) statusChanges.push({ id, from: b.privacy || 'unknown', to: v.privacy || 'unknown' });
    videoDeltas.push({ id, ...delta });
  }
  for (const f of fields) if (!commonMeasured[f]) commonDelta[f] = null;
  return { from: before.day, to: after.day, fromTaken: before.taken, toTaken: after.taken,
    elapsedDays: Number(((Date.parse(after.taken) - Date.parse(before.taken)) / 86400000).toFixed(2)),
    added: [...current.keys()].filter(id => !old.has(id)), noLongerAccessible: [...old.keys()].filter(id => !current.has(id)),
    statusChanges, commonDelta, commonMeasured, videoDeltas };
}

export function saveArchive(snapshot, { dir = historyDir() } = {}) {
  if (!valid(snapshot)) throw Error('Неполный снимок YouTube не сохраняется');
  const release = lock(path.join(dir, '.write.lock'));
  if (!release) throw Error('История YouTube занята');
  try {
    const file = path.join(dir, `${snapshot.day}.json`);
    if (existsSync(file)) {
      const existing = readJson(file);
      if (!valid(existing) || existing.channelId !== snapshot.channelId) throw Error('Конфликт снимка YouTube за день');
      return { saved: false, file };
    }
    writeJson(file, snapshot);
    return { saved: true, file };
  } finally { release(); }
}

export function historyAt(now = Date.now(), { dir = historyDir() } = {}) {
  if (!existsSync(dir)) return null;
  const list = readdirSync(dir).filter(f => /^[0-9]{4}-[0-9]{2}-[0-9]{2}\.json$/.test(f)).map(f => readJson(path.join(dir, f))).filter(s => valid(s) && Date.parse(s.taken) <= now).sort((a, b) => Date.parse(a.taken) - Date.parse(b.taken));
  const latest = list.at(-1);
  if (!latest) return null;
  const previous = days => list.filter(s => s.channelId === latest.channelId && Date.parse(s.taken) <= Date.parse(latest.taken) - days * 86400000).at(-1);
  const compare = before => before && before !== latest ? compareArchives(before, latest) : null;
  const statuses = {};
  for (const v of latest.list) statuses[v.privacy] = (statuses[v.privacy] || 0) + 1;
  return { latest, statuses, daily: compare(previous(1)), weekly: compare(previous(7)), baseline: compare(list.find(s => s.channelId === latest.channelId)),
    staleDays: Number(((now - Date.parse(latest.taken)) / 86400000).toFixed(2)) };
}

export async function collectHistory({ now = Date.now(), dry = false } = {}) {
  if (!has('YOUTUBE_REFRESH_TOKEN') || !has('YOUTUBE_CHANNEL_ID')) return { skipped: 'нет собственного OAuth YouTube' };
  const dir = historyDir();
  const release = lock(path.join(dir, '.collect.lock'));
  if (!release) return { skipped: 'сбор истории YouTube уже выполняется' };
  try {
    const file = path.join(dir, `${mskDate(now)}.json`);
    const previous = readJson(file);
    if (valid(previous) && previous.channelId === env('YOUTUBE_CHANNEL_ID')) {
      if (!dry) writeJson(dataPath('youtube', 'latest.json'), historyAt(now, { dir }));
      return { kind: 'ok', saved: false, videos: previous.list.length, alreadyCollected: true, analyticsState: previous.analyticsState };
    }
    const result = await fetchArchive({ now });
    if (result.kind !== 'ok') return result;
    const stored = dry ? { saved: false } : saveArchive(result.snapshot, { dir });
    if (!dry) writeJson(dataPath('youtube', 'latest.json'), historyAt(now, { dir }));
    return { kind: 'ok', ...stored, videos: result.snapshot.list.length, analyticsState: result.snapshot.analyticsState, day: result.snapshot.day };
  } finally { release(); }
}
