// Опись собственных материалов: страницы, нули, частичный отказ и границы Москвы.
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectBaseline, summarizeBaseline } from '../src/metrics/meta-baseline.mjs';

const from='2026-08-23T21:00:00.000Z', to='2026-10-18T21:00:00.000Z';
const now=Date.parse('2026-10-19T08:00:00Z');
const ok=data=>({kind:'ok',data,status:200});
const item=(id,timestamp='2026-10-01T12:00:00Z')=>({id,timestamp,caption:'Свой материал',text:'Свой материал',media_type:'IMAGE',permalink:'https://example.com/'+id,comments:[{text:'НЕ ЭКСПОРТИРОВАТЬ'}],username:'НЕ ЭКСПОРТИРОВАТЬ'});

test('все страницы, удаление дублей, текущая неделя отдельно; чужие поля и next URL не экспортируются',async()=>{
  const paths=[];
  const call=async(p,q)=>{paths.push(q);if(q.startsWith('me?'))return ok({id:'own',user_id:'own',username:'ecopolis_kzn',followers_count:0});
    if(q.includes('/media?')||q.includes('/threads?'))return q.includes('after=')?ok({data:[item('b','2026-10-19T01:00:00Z'),item('a')]}):ok({data:[item('a'),item('old','2026-08-20T00:00:00Z')],paging:{next:'https://evil.example/?access_token=SECRET',cursors:{after:'cursor1'}}});
    if(q.includes('/threads_insights'))return ok({data:[{name:'followers_count',values:[{value:0}]}]});
    return ok({data:[{name:'views',period:'lifetime',values:[{value:0}]}]});};
  const s=await collectBaseline({call,from,to,now,delay:async()=>{}});
  for(const c of s.channels){assert.equal(c.inventoryComplete,true);assert.equal(c.pages,2);assert.equal(c.duplicates,1);assert.equal(c.followers.value,0);assert.equal(c.list.length,2);assert.equal(c.list.find(x=>x.id==='a').window,'baseline');assert.equal(c.list.find(x=>x.id==='b').window,'current');assert.equal(c.list[0].metrics.views.value,0);assert.equal(c.list[0].metrics.likes.status,'missing');}
  assert.doesNotMatch(JSON.stringify(s),/НЕ ЭКСПОРТИРОВАТЬ|SECRET|evil.example/);
  assert.ok(paths.every(q=>!q.includes('/comments')&&!q.includes('/replies')&&!q.includes('/conversations')));
  const summary=summarizeBaseline(s); assert.equal(summary.channels[0].baselineCount,1);assert.equal(summary.channels[0].currentCount,1);
});

test('ошибка страницы и повтор курсора дают частичную опись, а не полную базу',async()=>{
  let pages=0;
  const call=async(p,q)=>{if(q.startsWith('me?'))return ok({id:'own',user_id:'own',username:'ecopolis_kzn',followers_count:1});if(q.includes('/media?')||q.includes('/threads?')){pages++;return p==='instagram'&&q.includes('after=')?{kind:'network',status:503,data:{error:{message:'секрет нельзя экспортировать'}}}:ok({data:[item('a')],paging:{next:'unused',cursors:{after:'repeat'}}});}return ok({data:[]});};
  const s=await collectBaseline({call,from,to,now,delay:async()=>{}});
  assert.ok(pages>=4);assert.equal(s.channels[0].inventoryComplete,false);assert.equal(s.channels[1].inventoryComplete,false);assert.doesNotMatch(JSON.stringify(s),/секрет нельзя/);
});

test('чужой профиль не приводит к чтению материалов, предел запросов отражается явно',async()=>{
  let calls=0; const call=async()=>{calls++;return ok({id:'other',username:'someone_else'});};
  const s=await collectBaseline({call,from,to,now,delay:async()=>{}});assert.equal(calls,2);assert.ok(s.channels.every(c=>c.status==='wrong_profile'&&c.list.length===0));
  const bounded=await collectBaseline({call,from,to,now,maxRequests:1,delay:async()=>{}});assert.equal(bounded.requests,1);assert.equal(bounded.channels[1].status,'profile_unavailable');
});
