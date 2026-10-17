import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'yt-comments-'));
process.env.ZAVOD_ENV_FILE = path.join(process.env.DATA_DIR, 'absent.env');
const { readYoutubeComments } = await import('../src/comments/youtube.mjs');

test('YouTube читает все страницы веток и ответов, не сохраняет автора', async () => {
  const paths = [];
  const comment = (id, author, text, videoId = 'v') => ({ id, snippet: { authorChannelId: { value: author }, authorDisplayName: 'private author', authorProfileImageUrl: 'private image', textOriginal: text, videoId, publishedAt: '2026-10-17T00:00:00Z' } });
  const call = async route => {
    paths.push(route);
    const u = new URL(route, 'https://test.invalid/');
    const page = u.searchParams.get('pageToken');
    if (u.pathname.endsWith('commentThreads')) return { kind: 'ok', data: page ? { items: [{ id: 't2', snippet: { topLevelComment: comment('c2', 'other', 'second'), totalReplyCount: 0 } }] } : { nextPageToken: 'threads2', items: [{ id: 't1', snippet: { topLevelComment: comment('own', 'UCown', 'own root'), totalReplyCount: 3 } }] } };
    return { kind: 'ok', data: page ? { items: [comment('r3', 'other', 'third')] } : { nextPageToken: 'replies2', items: [comment('r1', 'other', 'first'), comment('r2', 'UCown', 'own reply')] } };
  };
  const r = await readYoutubeComments({ channelId: 'UCown', call });
  assert.deepEqual(r.items.map(c => c.id).sort(), ['youtube:c2', 'youtube:r1', 'youtube:r3']);
  assert.equal(paths.length, 4);
  assert.ok(paths.every(p => !p.includes('key=')));
  assert.match(paths.find(p => p.startsWith('comments?')), /parentId=own/);
  assert.ok(!JSON.stringify(r).includes('private author'));
  assert.ok(!JSON.stringify(r).includes('authorChannelId'));
  assert.match(r.items.find(c => c.id === 'youtube:r3').link, /lc=r3/);
});

test('сбой второй страницы не выдаётся за полный сбор', async () => {
  let n = 0;
  const r = await readYoutubeComments({ channelId: 'UCown', call: async () => ++n === 1 ? { kind: 'ok', data: { items: [], nextPageToken: 'more' } } : { kind: 'network', status: 0, error: 'private response' } });
  assert.equal(r.items, undefined);
  assert.ok(r.error);
  assert.ok(!r.error.includes('private response'));
});

test('живой сбор с компьютера оператора блокируется до запроса', async () => {
  const r = await readYoutubeComments({ channelId: 'UCown' });
  assert.ok(r.skipped);
  const { collect } = await import('../src/comments/collect.mjs');
  const result = await collect({ dry: true, only: ['youtube'] });
  assert.deepEqual(result.fresh, []);
  assert.match(result.notes.join(' '), /только на российском сервере/);
});

test('повтор pageToken останавливает сбор и не выдаёт частичный результат', async () => {
  const r = await readYoutubeComments({ channelId: 'UCown', call: async () => ({ kind: 'ok', data: { items: [], nextPageToken: 'loop' } }) });
  assert.ok(r.error);
  assert.equal(r.items, undefined);
});

test('старая ветка архивируется, свежий ответ под ней остаётся новым', async () => {
  const { foundRow } = await import('../src/comments/collect.mjs');
  const now = Date.parse('2026-10-17T10:00:00Z');
  assert.equal(foundRow({ id: 'youtube:old', text: 'synthetic', at: '2020-01-01T00:00:00Z' }, now).status, 'archived');
  assert.equal(foundRow({ id: 'youtube:reply', parent: 'youtube:old', text: 'synthetic', at: '2026-10-17T00:00:00Z' }, now).status, 'new');
});
