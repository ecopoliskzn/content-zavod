import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';
process.env.ZAVOD_ENV_FILE=path.join(tmpdir(),'absent-meta-history.env');
const {collectDaily,compareSnapshots}=await import('../src/metrics/meta-history.mjs');
const metric=(value,at='2026-11-10T08:00:00Z')=>({value,status:'measured',source:'media_insights',period:'lifetime',takenAt:at});
const snap=(value,ids=['a'])=>({collectedFrom:'2026-11-10T08:00:00Z',collectedTo:'2026-11-10T08:01:00Z',channels:[{platform:'instagram',followers:metric(value),list:ids.map(id=>({id,publishedAt:'2026-11-01T00:00:00Z',format:'REELS',metrics:{views:metric(value)}}))}]});
test('сравнение сохраняет отрицательные поправки и отделяет новые ID, отсутствие и несовместимость',()=>{
 const before=snap(10),after=snap(8,['a','b']);after.channels[0].list[0].metrics.views.takenAt='2026-11-11T08:00:00Z';after.channels[0].followers.takenAt='2026-11-11T08:00:00Z';
 const c=compareSnapshots(before,after).channels[0];assert.equal(c.followers.delta,-2);assert.deepEqual(c.addedIds,['b']);assert.equal(c.posts[0].metrics.views.delta,-2);assert.equal(c.posts[0].metrics.views.correction,true);
 after.channels[0].list[0].metrics.views.status='missing';assert.equal(compareSnapshots(before,after).channels[0].posts[0].metrics.views.delta,null);
 after.channels[0].list[0].metrics.views=metric(8,'2026-11-11T08:00:00Z');after.channels[0].list[0].metrics.views.period='day';assert.equal(compareSnapshots(before,after).channels[0].posts[0].metrics.views.delta,null);
});
const ok=data=>({kind:'ok',status:200,data});
function fake(paths){return async(p,q)=>{paths.push(q);assert.doesNotMatch(q,/caption|fields=[^&]*\btext\b/);if(q.startsWith('me?'))return ok({id:'own',user_id:'own',username:'ecopolis_kzn',followers_count:5});if(q.includes('/threads_insights'))return ok({data:[{name:'followers_count',values:[{value:6}]}]});if(q.includes('/media?')||q.includes('/threads?'))return ok({data:[{id:'new',timestamp:'2026-11-09T08:00:00Z',media_type:'IMAGE',like_count:0,comments_count:0,caption:'DO_NOT_EXPORT',author:'DO_NOT_EXPORT'},{id:'old',timestamp:'2026-10-01T08:00:00Z',media_type:'IMAGE',like_count:0,comments_count:0}]});return ok({data:['views','reach','likes','comments','saved','shares','replies','reposts','quotes'].map(name=>({name,period:'lifetime',values:[{value:0}]}))});};}
test('суточный файл неизменяем; тексты не запрашиваются; старые метрики по будням не снимаются',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'meta-history-')),paths=[],now=Date.parse('2026-11-10T08:00:00Z');const r=await collectDaily({root,now,call:fake(paths),delay:async()=>{}});assert.equal(r.status,'COLLECTED');assert.equal(r.partial,false);
 const saved=readFileSync(r.file,'utf8');assert.doesNotMatch(saved,/DO_NOT_EXPORT|ownText|access_token/);const bundle=JSON.parse(saved);for(const c of bundle.snapshot.channels){assert.equal(c.list.find(x=>x.id==='old').metrics.views.status,'not_due');assert.equal(c.list.find(x=>x.id==='new').metrics.views.value,0);}assert.ok(paths.every(x=>!x.startsWith('old/insights')));
 const count=paths.length;assert.equal((await collectDaily({root,now,call:fake(paths)})).status,'ALREADY_COLLECTED');assert.equal(paths.length,count);assert.equal(readFileSync(r.file,'utf8'),saved);
});
test('частичная ошибка сохраняется как ошибка без нулей; существующий повреждённый файл не заменяется',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'meta-partial-')),now=Date.parse('2026-11-10T08:00:00Z');const r=await collectDaily({root,now,call:async()=>({kind:'network',status:0}),delay:async()=>{}});assert.equal(r.partial,true);const b=JSON.parse(readFileSync(r.file));assert.equal(b.snapshot.channels[0].followers.value,null);
 writeFileSync(r.file,'broken');await assert.rejects(collectDaily({root,now,call:async()=>{throw Error('must not call');}}));assert.equal(readFileSync(r.file,'utf8'),'broken');
  const next=await collectDaily({root,now:now+86400000,call:fake([]),delay:async()=>{}});assert.equal(JSON.parse(readFileSync(next.file)).warnings[0].kind,'previous_snapshot_unreadable');
});
test('понедельник определяется по Москве; второй исполнитель получает BUSY',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'meta-lock-')),paths=[];let entered,release;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r),base=fake(paths);let first=true;
 const call=async(p,q)=>{if(first){first=false;entered();await gate;}return base(p,q);};
 const now=Date.parse('2026-11-08T22:00:00Z'),running=collectDaily({root,now,call,delay:async()=>{}});await ready;
 try{assert.equal((await collectDaily({root,now,call:base})).status,'BUSY');}finally{release();}
 const r=await running;assert.match(r.file,/2026-11-09\.json$/);assert.ok(paths.some(q=>q.startsWith('old/insights')));
});
