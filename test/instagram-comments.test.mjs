import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
process.env.DATA_DIR=mkdtempSync(path.join(tmpdir(),'ig-comments-'));process.env.ZAVOD_ENV_FILE=path.join(process.env.DATA_DIR,'absent.env');
const load=()=>import('../src/comments/instagram.mjs');
const ok=data=>({kind:'ok',status:200,data});
test('Instagram проходит страницы media, комментариев и ответов без сохранения автора',async()=>{
 const {readInstagramComments}=await load();const paths=[];
 const result=await readInstagramComments({userId:'own',own:'company',pause:async()=>{},call:async route=>{
  paths.push(route);const u=new URL(route,'https://test.invalid/'),after=u.searchParams.get('after');
  if(u.pathname==='/own/media')return ok(after?{data:[{id:'m2',permalink:'https://example.org/2',comments_count:0}]}:{data:[{id:'m1',permalink:'https://example.org/1',comments_count:2}],paging:{next:'https://unsafe.invalid/?access_token=secret',cursors:{after:'page2'}}});
  if(u.pathname==='/m1/comments')return ok(after?{data:[{id:'own-c',text:'own',timestamp:'2026-11-05',username:'company'}]}:{data:[{id:'c1',text:'question',timestamp:'2026-11-05',username:'private-author'}],paging:{next:'ignored',cursors:{after:'next-comments'}}});
  if(u.pathname==='/c1/replies')return ok(after?{data:[{id:'r2',text:'reply2',timestamp:'2026-11-05',username:'private-author'}]}:{data:[{id:'r1',text:'reply',timestamp:'2026-11-05',username:'private-author'}],paging:{next:'ignored',cursors:{after:'next-replies'}}});
  return ok({data:[]});
 }});
 assert.deepEqual(result.items.map(x=>x.id).sort(),['instagram:c1','instagram:r1','instagram:r2']);
 assert.equal(result.coverage.complete,true);assert.equal(result.coverage.mediaPages,2);assert.equal(result.coverage.commentPages,2);
 assert.ok(!JSON.stringify(result).includes('private-author'));assert.ok(paths.every(p=>!p.includes('access_token=')&&!p.includes('unsafe.invalid')));
});
test('сбой внутреннего запроса не скрывается как пустой успешный сбор',async()=>{
 const {readInstagramComments}=await load();let n=0;
 const r=await readInstagramComments({userId:'own',pause:async()=>{},call:async()=>++n===1?ok({data:[{id:'m',comments_count:1}]}):{kind:'refused',status:403,data:{error:{code:10}},error:'private raw response'}});
 assert.ok(r.error);assert.equal(r.coverage.complete,false);assert.ok(!r.error.includes('private raw response'));assert.equal(r.items,undefined);
});
test('счётчик при пустой выдаче отмечается как расхождение, а не отсутствие вопросов',async()=>{
 const {readInstagramComments}=await load();let n=0;
 const r=await readInstagramComments({userId:'own',pause:async()=>{},call:async()=>++n===1?ok({data:[{id:'m',comments_count:3}]}):ok({data:[]})});
 assert.equal(r.coverage.complete,false);assert.equal(r.coverage.countMismatchMedia,1);assert.equal(r.coverage.visibleComments,0);assert.ok(r.error);
});
test('повтор курсора и лимит запросов дают явную остановку',async()=>{
 const {readInstagramComments}=await load();
 for(const maxRequests of [1,10]){const r=await readInstagramComments({userId:'own',maxRequests,pause:async()=>{},call:async()=>ok({data:[],paging:{next:'ignored',cursors:{after:'loop'}}})});assert.ok(r.error);assert.equal(r.coverage.complete,false);}
});
test('живое чтение с компьютера блокируется до первого запроса',async()=>{
 const {readInstagramComments}=await load();assert.ok((await readInstagramComments({userId:'own'})).skipped);
});
test('исключение транспорта не раскрывает тело ответа или URL',async()=>{
 const {readInstagramComments}=await load();const r=await readInstagramComments({userId:'own',call:async()=>{throw Error('private author access_token=synthetic');}});
 assert.ok(r.error);assert.ok(!JSON.stringify(r).includes('synthetic'));assert.ok(!r.error.includes('private author'));
});
