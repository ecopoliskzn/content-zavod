import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
const dir=mkdtempSync(path.join(tmpdir(),'intake-provenance-'));process.env.DATA_DIR=dir;process.env.ZAVOD_ENV_FILE=path.join(dir,'absent.env');
const {verifyIntakeResult}=await import('../src/bot/media-intake-delivery.mjs');
const {targetEntryName,targetKey}=await import('../src/bot/media-intake-targets.mjs');
const {intakeYoutubeWaiting}=await import('../src/queue/intake-youtube-first.mjs');
const material='intake:'+'a'.repeat(16),root=path.join(dir,'media-library');mkdirSync(path.join(root,'blobs'),{recursive:true});
function fixture(){
 const bytes=Buffer.from('publication bytes'),sha256=createHash('sha256').update(bytes).digest('hex');
 const original={mediaId:'med_'+'1'.repeat(32),role:'original',material,mime:'image/jpeg',sha256,bytes:bytes.length};
 const publication={...original,mediaId:'med_'+'2'.repeat(32),role:'publication',parent:original.mediaId};
 const job={materialId:'a'.repeat(16),revision:1,inputHash:'pinned',targets:[{channel:'instagram',format:'story'}],input:{policyVersion:'v1',files:[{...original}],facts:[],timing:{mode:'after_approval'}}};
 const result={inputHash:'pinned',editorialReview:{result:'passed',policyVersion:'v1'},variants:[{channel:'instagram',format:'story',text:'Монтаж покрытия на объекте.',mediaIds:[publication.mediaId],entry:{channel:'instagram',kind:'story',name:'mi-'+ 'a'.repeat(16)+'-1',material,text:'Монтаж покрытия на объекте.',facts:[],media:[{type:'image',mediaId:publication.mediaId}]}}]};
 const save=()=>{writeFileSync(path.join(root,'index.json'),JSON.stringify({items:[original,publication]}));writeFileSync(path.join(root,'blobs',sha256),bytes);};save();return{job,result,original,publication,save,sha256};
}
test('верификация проверяет реальные байты, источник и закреплённую версию',()=>{
 const f=fixture();assert.equal(verifyIntakeResult(f.result,f.job),true);
 writeFileSync(path.join(root,'blobs',f.sha256),'corrupt');assert.equal(verifyIntakeResult(f.result,f.job),false);f.save();
 f.publication.parent='med_'+'3'.repeat(32);f.save();assert.equal(verifyIntakeResult(f.result,f.job),false);
 f.publication.parent=f.original.mediaId;f.save();f.job.input.files[0].sha256='0'.repeat(64);assert.equal(verifyIntakeResult(f.result,f.job),false);
});
test('чужой материал, исходник вместо версии и скриншот вместо видео закрыты',()=>{
 const f=fixture();f.publication.role='original';f.save();assert.equal(verifyIntakeResult(f.result,f.job),false);
 f.publication.role='publication';f.publication.material='other';f.save();assert.equal(verifyIntakeResult(f.result,f.job),false);
 f.publication.material=material;f.original.mime='video/mp4';f.job.input.files[0].mime='video/mp4';f.save();assert.equal(verifyIntakeResult(f.result,f.job),false);
});
test('текстовый результат проходит без публикационных файлов и не одобряется',()=>{
 const f=fixture();f.job.targets=[{channel:'telegram',format:'text'}];f.job.input.files=[];
 const v=f.result.variants[0];v.channel='telegram';v.format='text';v.mediaIds=[];v.entry.channel='telegram';v.entry.kind='post';v.entry.media=[];
 assert.equal(verifyIntakeResult(f.result,f.job),true);assert.equal(v.entry.approval,undefined);
});
test('явный выбор исходника для Story запрещает дочернюю версию другого файла комплекта',()=>{
 const f=fixture(),other={...f.original,mediaId:'med_'+'3'.repeat(32)};
 f.job.input.files.push(other);f.job.input.targetMedia={'instagram:story':[other.mediaId]};
 assert.equal(verifyIntakeResult(f.result,f.job),false);
 f.job.input.targetMedia['instagram:story']=[f.original.mediaId];assert.equal(verifyIntakeResult(f.result,f.job),true);
 f.job.input.targetMedia={};assert.equal(verifyIntakeResult(f.result,f.job),false);
 delete f.job.input.targetMedia;assert.equal(verifyIntakeResult(f.result,f.job),true);
});
test('обложка role cover допустима только для выбранного видео с проверенными байтами',()=>{
 const f=fixture();f.original.mime='video/mp4';f.publication.mime='video/mp4';f.job.input.files[0].mime='video/mp4';
 const cover={...f.publication,mediaId:'med_'+'4'.repeat(32),role:'cover',mime:'image/jpeg'};
 f.job.input.targetMedia={'instagram:story':[f.original.mediaId]};
 f.result.variants[0].entry.media[0]={type:'video',mediaId:f.publication.mediaId,coverMediaId:cover.mediaId};
 const save=()=>{f.save();writeFileSync(path.join(root,'index.json'),JSON.stringify({items:[f.original,f.publication,cover]}));};
 save();assert.equal(verifyIntakeResult(f.result,f.job),true);
 cover.parent='med_'+'5'.repeat(32);save();assert.equal(verifyIntakeResult(f.result,f.job),false);
 cover.parent=f.original.mediaId;cover.bytes++;save();assert.equal(verifyIntakeResult(f.result,f.job),false);
 cover.bytes--;cover.role='original';save();assert.equal(verifyIntakeResult(f.result,f.job),false);
});
test('многоформатное видео проходит редакторский мост, выпуск ждёт точную премьеру YouTube',()=>{
 const f=fixture();f.original.mime='video/mp4';f.publication.mime='video/mp4';f.job.input.files[0].mime='video/mp4';f.save();
 f.job.status='completed';f.job.artifactsVerified=true;
 f.job.targets=[{channel:'youtube',format:'video'},{channel:'instagram',format:'reel'},{channel:'instagram',format:'story'}];
 f.job.input.targetMedia=Object.fromEntries(f.job.targets.map(t=>[targetKey(t),[f.original.mediaId]]));
 f.result.variants=f.job.targets.map(t=>({...t,text:'Монтаж покрытия на объекте.',mediaIds:[f.publication.mediaId],entry:{channel:t.channel,kind:t.format,name:targetEntryName(f.job,t),material,title:'Монтаж покрытия',text:'Монтаж покрытия на объекте.',facts:[],media:[{type:'video',mediaId:f.publication.mediaId}]}}));
 assert.equal(verifyIntakeResult(f.result,f.job),true);
 const reel=f.result.variants[1].entry,youtube={...f.result.variants[0].entry,contentHash:'exact',status:'approved'};
 f.job.queueResults={'youtube:video':{id:'yt',contentHash:'exact'}};
 const waiting=()=>intakeYoutubeWaiting(reel,{jobs:[f.job],getEntry:()=>youtube});
 assert.equal(waiting(),true);youtube.status='published';youtube.result={id:'video',link:'https://www.youtube.com/watch?v=example'};assert.equal(waiting(),false);
 youtube.contentHash='other';assert.equal(waiting(),true);
});
