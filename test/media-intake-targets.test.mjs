// Контракт форматов: структура не подменяет реальные API-проверки S0.
import test from 'node:test';import assert from 'node:assert/strict';
import {targetSpec,targetProblems,chooseTargets,recipientFor} from '../src/bot/media-intake-targets.mjs';
const target=(channel,format,over={})=>({channel,format,account_ref:'test-account',delivery_mode:'auto',readiness:'passed',verified_at:'2026-11-08T00:00:00Z',...over});
const photo={status:'verified',mime:'image/jpeg',mediaId:'med_photo'},video={status:'verified',mime:'video/mp4',mediaId:'med_video'};
test('все каналы имеют реальные queue kinds: текст без обязательной фотографии',()=>{
 for(const [channel,format,kind] of [['telegram','text','post'],['vk','post','post'],['bot','text','post'],['threads','thread','thread'],['dzen','article','article'],['youtube','short','short'],['rutube','video','video'],['instagram','reel','reel']])assert.equal(targetSpec(target(channel,format)).kind,kind);
 assert.deepEqual(targetProblems(target('threads','thread'),[]),[]);assert.ok(targetProblems(target('threads','video'),[video]).length);
});
test('фото и видео не подменяются друг другом, mixed требует явной совместимости',()=>{
 assert.ok(targetProblems(target('telegram','album'),[video]).some(x=>x.code==='photo_required'));
 assert.ok(targetProblems(target('youtube','video'),[photo]).some(x=>x.code==='video_required'));
 assert.deepEqual(targetProblems(target('youtube','video'),[photo,video]),[]);
 assert.deepEqual(chooseTargets([target('telegram','album'),target('youtube','short')],[video]).map(t=>t.channel),['youtube']);
 assert.equal(recipientFor([target('youtube','short'),target('telegram','text')]),'S2');assert.equal(recipientFor([target('vk','photopost')]),'S1');
});
test('not_ready и manual честные, не становятся auto по одной схеме',()=>{
 assert.ok(targetProblems(target('instagram','reel',{readiness:'not_ready',reason:'нет проверенного медиапути'}),[video]).some(x=>x.code==='target_not_ready'));
 assert.deepEqual(targetProblems(target('vk','video',{delivery_mode:'manual'}),[video]),[]);
 assert.ok(targetProblems(target('vk','video',{verified_at:null}),[video]).length);
});
