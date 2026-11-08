import test from 'node:test';import assert from 'node:assert/strict';
import {intakeYoutubeWaiting} from '../src/queue/intake-youtube-first.mjs';
const materialId='a'.repeat(16),name=`mi-${materialId}-1`;
const target={channel:'instagram',format:'reel'},yt={channel:'youtube',format:'short'};
const entry={id:'ig',name:name+'-112233',material:'intake:'+materialId,channel:'instagram',kind:'reel'};
const video={id:'yt',name,material:entry.material,channel:'youtube',kind:'short',contentHash:'exact',status:'published',result:{id:'video',link:'https://youtu.be/video'}};
const job={id:'job',materialId,revision:1,status:'completed',artifactsVerified:true,targets:[target,{channel:'instagram',format:'story'},yt],queueResults:{'instagram:reel':{id:'ig',contentHash:'ig'},'youtube:short':{id:'yt',contentHash:'exact'}}};
// Имена вычислены реальным helper; имена разных форматов не обязаны совпадать.
import {targetEntryName} from '../src/bot/media-intake-targets.mjs';
entry.name=targetEntryName(job,target);
const check=(jobs=[job],replacement=video,e=entry)=>intakeYoutubeWaiting(e,{jobs,getEntry:id=>id==='yt'?replacement:null});
test('разные имена одного job ждут точную опубликованную YouTube-квитанцию',()=>{
 assert.equal(check(),false);for(const replacement of [null,{...video,status:'approved'},{...video,status:'cancelled'},{...video,contentHash:'other'},{...video,result:{id:'video'}}])assert.equal(check([job],replacement),true);
});
test('чужая ревизия или job не снимают удержание; пустое состояние закрыто',()=>{
 assert.equal(check([{...job,revision:2}]),true);assert.equal(check([]),true);
 assert.equal(check([{...job,queueResults:{'youtube:short':{id:'other',contentHash:'exact'}}}]),true);
});
test('фото и текст не ждут YouTube; видео без YouTube target не заблокировано',()=>{
 for(const kind of ['post','album','article'])assert.equal(check([],null,{...entry,kind}),false);
 assert.equal(check([{...job,targets:job.targets.filter(t=>t.channel!=='youtube')}]),false);
});
test('legacy имя оставлено прежней проверке runner',()=>assert.equal(check([],null,{...entry,name:'old-video'}),null));
test('Telegram video с kind post ждёт YouTube; scoped rework сохраняет текущую премьеру',()=>{
 assert.equal(check([job],{...video,status:'approved'},{...entry,kind:'post',media:[{type:'video'}]}),true);
 const revised={...job,id:'rework',revision:2,targets:[target]},ig={...entry,name:targetEntryName(revised,target)};
 const material={targets:job.targets,targetJobs:{'instagram:reel':'rework','youtube:short':'job'}};
 assert.equal(intakeYoutubeWaiting(ig,{jobs:[job,revised],material,getEntry:()=>({...video,status:'approved'})}),true);
 assert.equal(intakeYoutubeWaiting(ig,{jobs:[job,revised],material,getEntry:()=>video}),false);
});
