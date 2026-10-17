// Комментарии YouTube читаются собственным OAuth только на российском сервере.
// Все страницы веток и ответов проходят до конца; автор используется лишь для
// исключения собственных реплик и не попадает в сохранённую запись.
import { api } from '../channels/youtube.mjs';
import { dataDir, env } from '../lib/env.mjs';

export async function readYoutubeComments({ channelId = env('YOUTUBE_CHANNEL_ID'), call = api } = {}) {
  if (call === api && !dataDir().startsWith('/opt/')) return { skipped: 'живое чтение комментариев разрешено только на российском сервере' };
  if (!channelId) return { skipped: 'нет YOUTUBE_CHANNEL_ID' };
  const items = new Map();
  const seenPages = new Set();
  let threadPages = 0, replyPages = 0, page = '';
  const failed = r => ({ error: `YouTube: сбор не завершён (${r.kind || 'refused'}, HTTP ${r.status || 0})` });
  const add = (comment, videoId, parentId = '', replies = 0) => {
    const s = comment?.snippet;
    if (!comment?.id || !s || s.authorChannelId?.value === channelId) return;
    items.set(comment.id, { id: `youtube:${comment.id}`, platform: 'youtube', at: s.publishedAt,
      text: String(s.textOriginal || s.textDisplay || ''),
      link: `https://www.youtube.com/watch?v=${encodeURIComponent(s.videoId || videoId || '')}&lc=${encodeURIComponent(comment.id)}`,
      post: s.videoId || videoId || '', ...(parentId ? { parent: `youtube:${parentId}` } : {}), replies });
  };
  do {
    if (seenPages.has(page)) return { error: 'YouTube: повтор страницы веток, сбор не завершён' };
    seenPages.add(page);
    const q = new URLSearchParams({ part: 'snippet', allThreadsRelatedToChannelId: channelId, order: 'time', maxResults: '100', textFormat: 'plainText', ...(page ? { pageToken: page } : {}) });
    const r = await call(`commentThreads?${q}`);
    if (r.kind !== 'ok' || !Array.isArray(r.data?.items)) return failed(r);
    threadPages++;
    for (const thread of r.data.items) {
      const top = thread.snippet?.topLevelComment;
      if (!top?.id) return { error: 'YouTube: неполная ветка, сбор не завершён' };
      const video = top.snippet?.videoId || thread.snippet?.videoId || '';
      add(top, video, '', Number(thread.snippet.totalReplyCount) || 0);
      if (!thread.snippet.totalReplyCount) continue;
      let replyPage = '';
      const seenReplies = new Set();
      do {
        if (seenReplies.has(replyPage)) return { error: 'YouTube: повтор страницы ответов, сбор не завершён' };
        seenReplies.add(replyPage);
        const q = new URLSearchParams({ part: 'snippet', parentId: top.id, maxResults: '100', textFormat: 'plainText', ...(replyPage ? { pageToken: replyPage } : {}) });
        const replies = await call(`comments?${q}`);
        if (replies.kind !== 'ok' || !Array.isArray(replies.data?.items)) return failed(replies);
        replyPages++;
        for (const reply of replies.data.items) add(reply, video, top.id);
        replyPage = replies.data.nextPageToken || '';
      } while (replyPage);
    }
    page = r.data.nextPageToken || '';
  } while (page);
  return { items: [...items.values()], coverage: { complete: true, moderation: 'published', threadPages, replyPages } };
}
