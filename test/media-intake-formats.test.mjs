import test from 'node:test';
import assert from 'node:assert/strict';
import {entryFromIntakeVariant} from '../src/bot/media-intake-delivery.mjs';
import {targetEntryName} from '../src/bot/media-intake-targets.mjs';
const build=(channel,format,extra={},targets)=>{
 const job={materialId:'a'.repeat(16),revision:1,targets:targets||[{channel,format}],input:{facts:[],timing:{mode:'after_approval'}}};
 const entry={channel,kind:format==='text'?'post':format,name:targetEntryName(job,{channel,format}),material:`intake:${job.materialId}`,text:'Объект',facts:[],media:[],...extra};
 return entryFromIntakeVariant({channel,format,text:'Объект',entry},job);
};
test('текст без медиа и настоящий тип карусели',()=>{
 assert.equal(build('telegram','text').kind,'post');
 assert.equal(build('instagram','carousel',{media:[{type:'image',mediaId:'med_a'},{type:'image',mediaId:'med_b'}]}).kind,'carousel');
});
test('разные форматы Instagram сохраняют разные имена',()=>{
 const targets=[{channel:'instagram',format:'carousel'},{channel:'instagram',format:'story'}];
 const a=build('instagram','carousel',{media:[{type:'image',mediaId:'med_a'},{type:'image',mediaId:'med_b'}]},targets);
 const b=build('instagram','story',{media:[{type:'image',mediaId:'med_a'}]},targets);
 assert.notEqual(a.name,b.name);
});
test('видеоформат не подменяется фотографией и URL модели закрыт',()=>{
 assert.throws(()=>build('youtube','video',{title:'Объект',media:[{type:'image',mediaId:'med_a'}]}));
 assert.throws(()=>build('telegram','text',{media:[{type:'image',url:'https://example.org/a.jpg'}]}));
});
test('видеоформаты и ручная статья сохраняют содержимое',()=>{
 for(const [channel,format] of [['youtube','short'],['youtube','video'],['rutube','video'],['vk','video'],['instagram','reel']]){
  const e=build(channel,format,{title:'Монтаж',media:[{type:'video',mediaId:'med_a',coverMediaId:'med_b'}]});
  assert.equal(e.kind,format);assert.equal(e.media[0].coverMediaId,'med_b');assert.equal(e.title,'Монтаж');
 }
 assert.equal(build('dzen','article',{title:'Монтаж'}).kind,'article');
 assert.deepEqual(build('threads','thread',{posts:['Объект']}).posts,['Объект']);
 assert.throws(()=>build('threads','video',{media:[{type:'video',mediaId:'med_a'}]}));
 assert.throws(()=>build('dzen','post'));
});
