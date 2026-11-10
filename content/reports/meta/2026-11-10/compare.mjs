// Сравнение только числовых снимков. Ошибки и отсутствие значений не превращаются в ноль.
import fs from 'node:fs';import assert from 'node:assert/strict';
import {summarizeBaseline} from '../../../../src/metrics/meta-baseline.mjs';
const root=new URL('./',import.meta.url),read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const current=read(new URL('source.json',root)),base=read(new URL('../../meta-baseline-2026-10-19T07-44-55.564Z.source.json',root));
assert.deepEqual(summarizeBaseline(current),read(new URL('aggregate.json',root)));
const delta=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)?b-a:null;
const channels=current.channels.map(c=>{const b=base.channels.find(x=>x.platform===c.platform),old=new Map((b?.list||[]).map(r=>[r.id,r]));
 return {platform:c.platform,followersBefore:b?.followers,followersNow:c.followers,followersDelta:delta(b?.followers.value,c.followers.value),inventoryComplete:c.inventoryComplete,metricsComplete:c.metricsComplete,pages:c.pages,duplicates:c.duplicates,invalidRows:c.invalidRows,stopReason:c.stopReason,errors:c.errors,posts:c.list.map(r=>({id:r.id,link:r.permalink,publishedAt:r.publishedAt,format:r.format,newSinceBaseline:Date.parse(r.publishedAt)>=Date.parse(base.currentTo),metrics:Object.fromEntries(Object.entries(r.metrics).map(([name,m])=>[name,{...m,previous:old.get(r.id)?.metrics[name]?.value??null,delta:delta(old.get(r.id)?.metrics[name]?.value,m.value)}]))}))};});
const out={baselineFrom:base.collectedFrom,baselineTo:base.collectedTo,currentFrom:current.collectedFrom,currentTo:current.collectedTo,channels};
fs.writeFileSync(new URL('comparison.json',root),JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify(channels.map(c=>({platform:c.platform,followers:c.followersNow.value,change:c.followersDelta,posts:c.posts.length,new:c.posts.filter(p=>p.newSinceBaseline).length,complete:c.inventoryComplete&&c.metricsComplete}))));
