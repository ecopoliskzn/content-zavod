import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'tg-album-'));
process.env.ZAVOD_ENV_FILE=path.join(dir,'absent.env');process.env.DATA_DIR=dir;
process.env.TG_RELAY_URL='https://relay.invalid';process.env.TG_RELAY_SECRET='synthetic';process.env.TG_CHANNEL='@example';
const telegram=await import('../src/channels/telegram.mjs');
const client=await import('../src/lib/telegram.mjs');
const {handle}=await import('../ops/relay/relay.mjs');
mkdirSync(path.join(dir,'media','case'),{recursive:true});
for(let i=1;i<=4;i++)writeFileSync(path.join(dir,'media','case',`${i}.jpg`),String(i));
const entry=()=>({text:'<b>Синтетическая подпись</b>',media:[4,3,2,1].map(i=>({type:'image',url:`local:case/${i}.jpg`}))});
const messages=(n=4)=>Array.from({length:n},(_,i)=>({message_id:100+i,media_group_id:'group',chat:{id:-10042,username:'example'},photo:[{file_id:`photo${i}`}]}));
const json=result=>Response.json({ok:true,result});

test('альбом: четыре фото идут одним multipart в порядке 4,3,2,1; подпись одна; все ID возвращены',async()=>{
  const old=globalThis.fetch;let calls=0;const states=[];
  globalThis.fetch=async(url,opts)=>{calls++;assert.match(url,/\/upload\/sendMediaGroup$/);const form=opts.body;
    const media=JSON.parse(form.get('media'));assert.equal(media.length,4);
    assert.equal(media.filter(x=>x.caption).length,1);assert.equal(media[0].parse_mode,'HTML');
    for(let i=0;i<4;i++)assert.equal(await form.get(media[i].media.slice(9)).text(),String(4-i));
    return json(messages());};
  try {const r=await telegram.publish(entry(),{onState:async s=>states.push(s)});assert.equal(r.ok,true);assert.equal(calls,1);assert.equal(r.id,'100');assert.deepEqual(r.messageIds,['100','101','102','103']);assert.equal(r.mediaGroupId,'group');assert.ok(states.some(s=>s.tgAlbumComplete));}
  finally{globalThis.fetch=old;}
});

test('альбом: обрыв не повторяется; подпись на витрине не доказывает полноту',async()=>{
  const old=globalThis.fetch;let calls=0;let state={};
  globalThis.fetch=async()=>{calls++;throw Error('synthetic disconnect');};
  try{const r=await telegram.publish(entry(),{onState:async s=>Object.assign(state,s)});assert.equal(r.ok,false);assert.equal(calls,1);assert.equal(state.tgSending,true);
    globalThis.fetch=async()=>{calls++;return new Response('<div class="tgme_widget_message_wrap"><div data-post="example/100">Синтетическая подпись</div>');};
    const second=await telegram.publish({...entry(),result:state},{verify:true});assert.equal(second.ok,false);assert.equal(second.retry,false);assert.ok(calls<=2);
  }finally{globalThis.fetch=old;}
});

test('альбом: неполный или противоречивый ответ не становится публикацией',async()=>{
  const old=globalThis.fetch;
  try{for(const reply of [messages(2),[...messages(3),messages()[0]],messages().map((m,i)=>({...m,media_group_id:i?'other':'group'}))]){
    globalThis.fetch=async()=>json(reply);const r=await telegram.publish(entry());assert.equal(r.ok,false);assert.equal(r.retry,false);
  }}finally{globalThis.fetch=old;}
});

test('альбом: границы и неподдерживаемые кнопки отклоняются до сети',async()=>{
  const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return json(messages());};
  try{for(const e of [{...entry(),media:Array(11).fill(entry().media[0])},{...entry(),text:'x'.repeat(1025)},{...entry(),buttons:[[{text:'link',url:'https://example.org'}]]},{...entry(),media:[entry().media[0],{type:'video',url:'local:case/1.jpg'}]}]){assert.equal((await telegram.publish(e)).ok,false);}assert.equal(calls,0);}finally{globalThis.fetch=old;}
});

test('multipart: повтор имени файла безопасен, повтор attach-поля отклоняется',async()=>{
  const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return json(messages(2));};
  const fields={chat_id:'@example',media:[{type:'photo',media:'attach://p0'},{type:'photo',media:'attach://p1'}]};
  const files=[{field:'p0',file:{buffer:Buffer.from('a'),name:'same.jpg'}},{field:'p1',file:{buffer:Buffer.from('b'),name:'same.jpg'}}];
  try{assert.equal((await client.tgUploadMany('sendMediaGroup',fields,files)).kind,'ok');assert.equal((await client.tgUploadMany('sendMediaGroup',fields,[files[0],files[0]])).kind,'refused');assert.equal(calls,1);}finally{globalThis.fetch=old;}
});

test('альбом: 2 и 10 фото принимаются; полный сохранённый результат восстанавливается без сети',async()=>{
  const old=globalThis.fetch;let calls=0;
  try{for(const n of [2,10]){
    const e={...entry(),media:Array(n).fill(entry().media[0])};let state={};
    globalThis.fetch=async()=>{calls++;return json(messages(n));};
    const r=await telegram.publish(e,{onState:async s=>Object.assign(state,s)});assert.equal(r.ok,true);assert.equal(r.messageIds.length,n);
    const before=calls;const recovered=await telegram.publish({...e,result:state},{verify:true});assert.equal(recovered.ok,true);assert.equal(calls,before);
  }}finally{globalThis.fetch=old;}
});
test('одно фото сохраняет прежний sendPhoto; отсутствующий локальный файл не начинает отправку',async()=>{
  const old=globalThis.fetch;let calls=0;let state={};
  globalThis.fetch=async(url,opts)=>{calls++;assert.match(url,/\/api\/sendPhoto$/);assert.equal(JSON.parse(opts.body).photo,'https://example.org/one.jpg');return json(messages(1)[0]);};
  try{assert.equal((await telegram.publish({text:'single',media:[{type:'image',url:'https://example.org/one.jpg'}]})).ok,true);
    const r=await telegram.publish({...entry(),media:[{type:'image',url:'local:missing.jpg'},entry().media[1]]},{onState:async s=>Object.assign(state,s)});assert.equal(r.ok,false);assert.equal(calls,1);assert.equal(state.tgSending,undefined);
  }finally{globalThis.fetch=old;}
});
test('multipart: отсутствующая attach-ссылка и лишний файл не отправляются',async()=>{
  const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('not expected');};
  try{const r=await client.tgUploadMany('sendMediaGroup',{media:[{type:'photo',media:'attach://wrong'}]},[{field:'p0',file:{buffer:Buffer.from('a'),name:'a.jpg'}}]);assert.equal(r.kind,'refused');assert.equal(calls,0);}finally{globalThis.fetch=old;}
});

test('релей: multipart с повторяющимися file fields передаётся байт-в-байт без перестановки',async()=>{
  const form=new FormData();form.append('media','[{"type":"photo","media":"attach://p"}]');form.append('p',new Blob(['4']),'same.jpg');form.append('p',new Blob(['3']),'same.jpg');
  const input=new Request('https://relay.invalid/upload/sendMediaGroup',{method:'POST',headers:{'x-relay-secret':'synthetic'},body:form});
  const expected=new Uint8Array(await input.clone().arrayBuffer());let count=0;
  const r=await handle(input,{TG_RELAY_SECRET:'synthetic',TG_BOT_TOKEN:'synthetic'},async(url,opts)=>{count++;const actual=new Request('https://api.invalid/',opts);assert.deepEqual(new Uint8Array(await actual.arrayBuffer()),expected);assert.equal(actual.headers.get('content-type'),input.headers.get('content-type'));return json(messages(2));});
  assert.equal(r.status,200);assert.equal(count,1);
});
