import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'tg-import-'));process.env.DATA_DIR=dir;process.env.ZAVOD_ENV_FILE=path.join(dir,'absent.env');
process.env.TG_RELAY_URL='https://relay.example';process.env.TG_RELAY_SECRET='test-only';
const {importTelegramPhoto,attachTelegramOriginal,importTelegramFile}=await import('../src/media/telegram-import.mjs');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=','base64');
const input={fileId:'photo_test',bytes:png.length,material:'case:tg-test',source:'telegram:message:1',variant:'message-1'};
const opts={fetcher:async()=>new Response(png,{headers:{'content-length':String(png.length)}}),decode:async()=>({width:1,height:1}),space:()=>({freeBytes:2*1024**3,quotaBytes:512*1024**2,bytes:0})};
test('файл импортируется закрытым original и повтор не создаёт вторую версию',async()=>{
 const a=await importTelegramPhoto(input,opts),b=await importTelegramPhoto(input,opts);assert.equal(a.mediaId,b.mediaId);assert.equal(a.role,'original');assert.equal(a.delivery,null);assert.equal(a.mime,'image/png');assert.equal(a.bytes,png.length);
 assert.deepEqual(readFileSync(path.join(dir,'media-library','blobs',a.sha256)),png);assert.equal(readdirSync(path.join(dir,'telegram-staging')).length,0);
});
test('закрытый SSH-оригинал привязывается только своей ревизии и сбрасывает согласие на состав',async()=>{
 const row=await importTelegramPhoto({...input,material:'intake:manual-test'},opts);
 const state={materials:{'manual-test':{revision:2,manifest_revision:1,mode:'submitted',rights:{status:'confirmed'},card:{dirty:false},files:[{fileUniqueId:'manual',status:'failed'}]}},jobs:{old:{materialId:'manual-test',revision:2,status:'claimed'}}};
 const app={store:{tx:fn=>fn(state)}};
 await assert.rejects(()=>attachTelegramOriginal(app,{id:'wrong',revision:2,fileUniqueId:'manual',mediaId:row.mediaId},{decode:opts.decode}));
 await assert.rejects(()=>attachTelegramOriginal(app,{id:'manual-test',revision:1,fileUniqueId:'manual',mediaId:row.mediaId},{decode:opts.decode}));
 const result=await attachTelegramOriginal(app,{id:'manual-test',revision:2,fileUniqueId:'manual',mediaId:row.mediaId},{decode:opts.decode});assert.equal(result.revision,3);assert.equal(result.publicationApproved,false);assert.equal(state.jobs.old.status,'superseded');assert.equal(state.materials['manual-test'].rights.status,'needs_clarification');
});
test('видеоконтейнер разрешён только video/document и проходит тот же ограниченный импорт',async()=>{
 const mp4=Buffer.from([0,0,0,16,102,116,121,112,105,115,111,109,0,0,0,0]);
 const video={...opts,fetcher:async()=>new Response(mp4,{headers:{'content-length':String(mp4.length)}})};
 const row=await importTelegramFile({fileId:'video_1',size:mp4.length,kind:'video',material:'intake:video',source:'synthetic',variant:'video_1'},video);assert.equal(row.mime,'video/mp4');assert.equal(row.role,'original');
 await assert.rejects(()=>importTelegramFile({fileId:'video_1',size:mp4.length,kind:'photo',material:'intake:video',source:'synthetic',variant:'photo_1'},video));
});
test('неизвестный размер уточняется у релея, использованная квота проверяется до загрузки',async()=>{
 const row=await importTelegramPhoto({...input,bytes:undefined},opts);assert.equal(row.bytes,png.length);
 let calls=0;await assert.rejects(()=>importTelegramPhoto(input,{...opts,space:()=>({freeBytes:2*1024**3,quotaBytes:100,bytes:99}),fetcher:async()=>{calls++;throw Error('unexpected');}}));assert.equal(calls,0);
});
test('размер, тип, обрыв, декодирование и нехватка места не дают mediaId',async()=>{
 for(const [change,options] of [[{bytes:1},opts],[{}, {...opts,fetcher:async()=>new Response('not image')}],[{}, {...opts,decode:async()=>{throw Error('decode');}}],[{}, {...opts,space:()=>({freeBytes:1,quotaBytes:512*1024**2})}]])await assert.rejects(()=>importTelegramPhoto({...input,...change},options));
 assert.equal(readdirSync(path.join(dir,'telegram-staging')).length,0);
});
test('лимиты проверяются до сети и имя не принимается как путь',async()=>{
 let calls=0;const options={...opts,fetcher:async()=>{calls++;throw Error('unexpected');}};
 for(const change of [{fileId:'../private'},{bytes:21*1024**2},{bytes:0},{variant:'../../private'}])await assert.rejects(()=>importTelegramPhoto({...input,...change},options));assert.equal(calls,0);
});
