import test from 'node:test';import assert from 'node:assert/strict';import {readThreadsComments} from '../src/comments/threads.mjs';
test('опись Threads вне журнала, все страницы conversation и вложенные ответы без авторов',async()=>{
 const routes=[],call=async route=>{routes.push(route);const u=new URL(route,'https://test/'),after=u.searchParams.get('after');
  if(u.pathname==='/own/threads')return{kind:'ok',data:after?{data:[{id:'outside2',permalink:'https://www.threads.net/@company/post/2'}]}:{data:[{id:'outside1',permalink:'https://www.threads.net/@company/post/1'}],paging:{next:'https://evil.test/?access_token=NEVER_FOLLOW',cursors:{after:'next-post'}}}};
  return{kind:'ok',data:{data:after?[{id:'nested',text:'Синтетический вложенный ответ.',username:'PRIVATE_AUTHOR',timestamp:'2026-11-10T06:00:00Z',permalink:'https://www.threads.net/@x/post/r'}]:[{id:'self',text:'own',username:'company'}],...(!after?{paging:{next:'ignored',cursors:{after:'next-reply'}}}:{})}};};
 const result=await readThreadsComments({userId:'own',own:'company',call,pause:async()=>{}});assert.equal(result.coverage.complete,true);assert.equal(result.coverage.posts,2);assert.equal(result.coverage.postPages,2);assert.equal(result.coverage.replyPages,4);assert.ok(result.items.some(c=>c.id==='threads:nested'));assert.ok(!JSON.stringify(result).includes('PRIVATE_AUTHOR'));assert.ok(!routes.some(r=>r.includes('evil.test')||r.includes('access_token')));assert.ok(routes.some(r=>r.includes('/conversation?')));
});
test('ошибка страницы/повтор курсора/пустая опись не подтверждают отсутствие комментариев',async()=>{
 for(const call of [async()=>({kind:'network',status:0,error:'SECRET'}),async()=>({kind:'ok',data:{data:[]}}),async()=>({kind:'ok',data:{data:[],paging:{next:'ignored',cursors:{after:'repeat'}}}})]){
  const r=await readThreadsComments({userId:'own',own:'company',call,pause:async()=>{}});assert.equal(r.coverage.complete,false);assert.ok(r.error);assert.equal(r.items,undefined);assert.ok(!r.error.includes('SECRET'));
 }
});
