import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPage, collectSites } from '../src/trends/sites.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('Сайты: неизвестные метрики, дедупликация ссылок и запрет VK', async () => {
  const result = await inspectPage({sourceId:'a',url:'https://example.org/blog/'}, async () => new Response('<title>Материалы</title><a href="/blog/a?utm_source=x">A</a><a href="/blog/a">A</a><a href="https://vk.ru/a">VK</a>',{headers:{'content-type':'text/html'}}));
  assert.equal(result.metrics, null);
  assert.deepEqual(result.candidates, ['https://example.org/blog/a']);
  let called = false;
  const forbidden = await inspectPage({url:'https://vk.ru/test'}, async () => {called=true;});
  assert.equal(forbidden.status, 'blocked'); assert.equal(called, false);
});
test('Сайты: внешние перенаправления и PDF не выдаются за прочитанный материал', async () => {
  const redirect = await inspectPage({url:'https://example.org/'}, async () => new Response('', {status:302,headers:{location:'https://vk.com/a'}}));
  assert.equal(redirect.status, 'redirect-not-followed');
  const pdf = await inspectPage({url:'https://example.org/test.pdf'}, async () => {throw Error('not called');});
  assert.equal(pdf.status, 'unsupported-pdf'); assert.equal(pdf.textRead, false);
});
test('Сайты: датированный результат и один проход за день без нулевых метрик', async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'trends-sites-')); let calls=0;
  try {
    const options={dir, now:Date.parse('2026-10-19T07:00:00Z'), targets:[{sourceId:'a',url:'https://example.org/blog/'}], fetcher:async()=>{calls++; return new Response('<title>Статья</title>',{headers:{'content-type':'text/html'}});}};
    const first=await collectSites(options); const second=await collectSites(options);
    assert.equal(first.date,'2026-10-19'); assert.equal(first.pages[0].metrics,null);
    assert.equal(second.duplicateDay,true); assert.equal(calls,1);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
