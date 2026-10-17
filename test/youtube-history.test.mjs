import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'yt-history-'));
process.env.ZAVOD_ENV_FILE = path.join(process.env.DATA_DIR, 'absent.env');
const { fetchArchive, compareArchives, saveArchive, historyAt } = await import('../src/metrics/youtube-history.mjs');
const video = (id, views, privacy = 'public') => ({ id, title: id, views, likes: 1, comments: 0, privacy, availability: 'available' });
const snap = (day, list) => ({ version: 1, complete: true, channelId: 'UCown', taken: `${day}T04:10:00Z`, day, subscribers: 10, list });

test('ежедневная опись включает старые и закрытые видео, все страницы и неизвестные счётчики', async () => {
  const requests = [];
  const result = await fetchArchive({ channelId: 'UCown', now: Date.parse('2026-10-17T04:10:00Z'), call: async route => {
    requests.push(route);
    const u = new URL(route, 'https://test.invalid/');
    if (u.pathname === '/channels') return { kind: 'ok', data: { items: [{ id: 'UCown', contentDetails: { relatedPlaylists: { uploads: 'uploads' } }, statistics: { subscriberCount: '10' } }] } };
    if (u.pathname === '/playlistItems') return { kind: 'ok', data: u.searchParams.has('pageToken') ? { items: [{ contentDetails: { videoId: 'missing' } }] } : { nextPageToken: 'next', items: [{ contentDetails: { videoId: 'old' } }, { contentDetails: { videoId: 'private' } }] } };
    return { kind: 'ok', data: { items: [{ id: 'old', snippet: { title: 'old', publishedAt: '2018-01-01' }, status: { privacyStatus: 'public' }, statistics: { viewCount: '10' } }, { id: 'private', status: { privacyStatus: 'private' }, statistics: {} }] } };
  }, readAnalytics: async () => ({ kind: 'ok', until: '2026-10-14', byId: new Map([['old', { avgSec: 12 }]]) }) });
  assert.equal(result.kind, 'ok');
  assert.equal(result.snapshot.list.length, 3);
  assert.equal(result.snapshot.list.find(v => v.id === 'private').privacy, 'private');
  assert.equal(result.snapshot.list.find(v => v.id === 'private').views, null);
  assert.equal(result.snapshot.list.find(v => v.id === 'missing').availability, 'unavailable');
  assert.ok(requests.find(p => p.startsWith('videos?')).includes('status'));
});

test('ошибка страницы не сохраняет ложные удаления, неверный канал не принимается', async () => {
  const r = await fetchArchive({ channelId: 'UCown', call: async () => ({ kind: 'ok', data: { items: [{ id: 'wrong' }] } }) });
  assert.notEqual(r.kind, 'ok');
  let count = 0;
  const partial = await fetchArchive({ channelId: 'UCown', call: async () => {
    if (++count === 1) return { kind: 'ok', data: { items: [{ id: 'UCown', contentDetails: { relatedPlaylists: { uploads: 'u' } } }] } };
    if (count === 2) return { kind: 'ok', data: { items: [{ contentDetails: { videoId: 'a' } }], nextPageToken: 'more' } };
    return { kind: 'network' };
  } });
  assert.equal(partial.kind, 'network');
  assert.equal(partial.snapshot, undefined);
});

test('отказ Analytics не стирает полную опись и не превращается в нулевой досмотр', async () => {
  const result = await fetchArchive({ channelId: 'UCown', call: async route => route.startsWith('channels?')
    ? { kind: 'ok', data: { items: [{ id: 'UCown', contentDetails: { relatedPlaylists: { uploads: 'u' } } }] } }
    : route.startsWith('playlistItems?') ? { kind: 'ok', data: { items: [{ contentDetails: { videoId: 'a' } }] } }
    : { kind: 'ok', data: { items: [{ id: 'a', statistics: { viewCount: '5' } }] } }, readAnalytics: async () => ({ kind: 'network' }) });
  assert.equal(result.snapshot.list[0].views, 5);
  assert.equal(result.snapshot.list[0].analytics, null);
  assert.equal(result.snapshot.analyticsState, 'network');
});

test('сравнение отделяет изменения состава и статусов от прироста одних и тех же видео', () => {
  const a = snap('2026-10-10', [video('a', 100), video('gone', 500), video('private', null, 'private')]);
  const b = snap('2026-10-17', [video('a', 90, 'unlisted'), video('new', 1000), video('private', 10, 'private')]);
  const r = compareArchives(a, b);
  assert.deepEqual(r.added, ['new']);
  assert.deepEqual(r.noLongerAccessible, ['gone']);
  assert.equal(r.commonDelta.views, -10);
  assert.equal(r.commonMeasured.views, 1);
  assert.deepEqual(r.statusChanges, [{ id: 'a', from: 'public', to: 'unlisted' }]);
  const unknown = compareArchives(snap('2026-10-10', [video('a', null)]), snap('2026-10-17', [video('a', 10)]));
  assert.equal(unknown.commonDelta.views, null);
  assert.equal(unknown.commonMeasured.views, 0);
});

test('снимок дня не перезаписывается, сравнение недели использует реальную дату базы', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'yt-archive-'));
  assert.equal(saveArchive(snap('2026-10-08', [video('a', 1)]), { dir }).saved, true);
  assert.equal(saveArchive(snap('2026-10-17', [video('a', 5)]), { dir }).saved, true);
  assert.equal(saveArchive(snap('2026-10-17', [video('a', 99)]), { dir }).saved, false);
  const report = historyAt(Date.parse('2026-10-17T23:00:00Z'), { dir });
  assert.equal(report.weekly.from, '2026-10-08');
  assert.equal(report.weekly.to, '2026-10-17');
  assert.equal(report.weekly.commonDelta.views, 4);
  assert.equal(readdirSync(dir).filter(f => f.endsWith('.json')).length, 2);
});

test('mirror не выдаёт остановившийся сбор за свежий снимок', async () => {
  mkdirSync(path.join(process.env.DATA_DIR, 'youtube'), { recursive: true });
  writeFileSync(path.join(process.env.DATA_DIR, 'youtube', 'latest.json'), JSON.stringify({ latest: snap('2026-10-10', []), staleDays: 0 }));
  const { snapshot } = await import('../src/queue/snapshot.mjs');
  const state = snapshot(Date.parse('2026-10-17T04:10:00Z'));
  assert.equal(state.youtubeHistory.staleDays, 7);
});
