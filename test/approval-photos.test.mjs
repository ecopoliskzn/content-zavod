import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'approval-photos-'));process.env.DATA_DIR=dir;process.env.ZAVOD_ENV_FILE=path.join(dir,'absent.env');process.env.TG_BOT_TOKEN='synthetic';process.env.TG_GROUP_ID='-10042';process.env.TG_TOPIC_APPROVAL='70';
const {put,get}=await import('../src/queue/store.mjs');const {submit}=await import('../src/bot/approval.mjs');
const entry=(name,n=4)=>({channel:'telegram',kind:'post',name,material:'blog:synthetic',date:'2030-06-04',time:'12:00',text:`${name}: ровность покрытия проверяют правилом. Заметные зазоры фиксируют при приёмке.`,media:Array.from({length:n},(_,i)=>({type:'image',url:`https://example.org/${4-i}.jpg`}))});
const photos=n=>Array.from({length:n},(_,i)=>({message_id:101+i,media_group_id:'group',photo:[{}],chat:{id:-10042}}));
test('submit: нативный альбом перед связанной карточкой, порядок и тот же contentHash',async()=>{
 const old=globalThis.fetch,calls=[];globalThis.fetch=async(url,opts)=>{
  if(String(url).startsWith('https://example.org'))return new Response(String(url).split('/').pop());
  const method=String(url).split('/').pop();calls.push({method,body:opts.body});
  return Response.json({ok:true,result:method==='sendMediaGroup'?photos(4):{message_id:200,chat:{id:-10042}}});};
 try{const e=(await put(entry('photo-native'))).entry;await submit(e.id);assert.deepEqual(calls.map(c=>c.method),['sendMediaGroup','sendMessage']);
  const media=JSON.parse(calls[0].body.get('media'));for(let i=0;i<4;i++)assert.equal(await calls[0].body.get(media[i].media.slice(9)).text(),`${4-i}.jpg`);
  assert.equal(calls[0].body.get('message_thread_id'),'70');const card=JSON.parse(calls[1].body);assert.equal(card.reply_parameters.message_id,101);assert.ok(card.reply_markup);
  const row=get(e.id);assert.equal(row.approval.preview.hash,row.contentHash);assert.deepEqual(row.approval.preview.messageIds,['101','102','103','104']);assert.equal(row.status,'review');
 }finally{globalThis.fetch=old;}
});
test('submit: неопределённая отправка фото не получает кнопок и не повторяется',async()=>{
 const old=globalThis.fetch;let sends=0;globalThis.fetch=async(url)=>{if(String(url).startsWith('https://example.org'))return new Response('photo');sends++;throw Error('synthetic disconnect');};
 try{const e=(await put(entry('photo-uncertain'))).entry;await assert.rejects(()=>submit(e.id));await assert.rejects(()=>submit(e.id));assert.equal(sends,1);assert.equal(get(e.id).status,'draft');}finally{globalThis.fetch=old;}
});
test('submit: одна фотография нативная, неполный альбом не становится карточкой',async()=>{
 const old=globalThis.fetch;const calls=[];globalThis.fetch=async(url,opts)=>{if(String(url).startsWith('https://example.org'))return new Response('photo');const method=String(url).split('/').pop();calls.push(method);return Response.json({ok:true,result:method==='sendMediaGroup'?photos(2):{message_id:101,photo:[{}],chat:{id:-10042}}});};
 try{const a=(await put(entry('photo-single',1))).entry;await submit(a.id);assert.deepEqual(calls,['sendPhoto','sendMessage']);calls.length=0;const b=(await put(entry('photo-partial'))).entry;await assert.rejects(()=>submit(b.id));assert.deepEqual(calls,['sendMediaGroup']);assert.equal(get(b.id).status,'draft');}finally{globalThis.fetch=old;}
});
test('submit: проверка блокирует недопустимый текст до отправки фотографий',async()=>{
 const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('not expected');};
 try{const e=(await put({...entry('photo-invalid'),text:'Покрытие [здесь срок] лет.'})).entry;await assert.rejects(()=>submit(e.id));assert.equal(calls,0);}finally{globalThis.fetch=old;}
});
test('submit: изменение содержимого во время отправки фото не получает действующих кнопок',async()=>{
 const old=globalThis.fetch;let id;const calls=[];
 globalThis.fetch=async(url,opts)=>{if(String(url).startsWith('https://example.org'))return new Response('photo');calls.push(String(url).split('/').pop());await put({...entry('photo-race'),text:'Покрытие осмотрели после завершения работ. Теперь проверяем примыкания.'});return Response.json({ok:true,result:photos(4)});};
 try{id=(await put(entry('photo-race'))).entry.id;await assert.rejects(()=>submit(id),/изменился/);assert.deepEqual(calls,['sendMediaGroup']);assert.equal(get(id).status,'draft');}finally{globalThis.fetch=old;}
});
test('ручное подтверждение отсутствующей карточки сохраняет уже доставленный альбом',async()=>{
 const old=globalThis.fetch,calls=[];let cardAttempt=0;
 globalThis.fetch=async(url)=>{if(String(url).startsWith('https://example.org'))return new Response('photo');const method=String(url).split('/').pop();calls.push(method);if(method==='sendMessage'&&cardAttempt++===0)throw Error('synthetic disconnect');return Response.json({ok:true,result:method==='sendMediaGroup'?photos(4):{message_id:200,chat:{id:-10042}}});};
 try{const id=(await put(entry('photo-card-recovery'))).entry.id;await assert.rejects(()=>submit(id));const {execute}=await import('../src/queue/commands.mjs');const no=await execute('preview-reset',{ref:id});assert.equal(no.code,1);const reset=await execute('preview-reset',{ref:id,'confirm-card-absent':true});assert.equal(reset.code,0);await submit(id);assert.equal(calls.filter(x=>x==='sendMediaGroup').length,1);assert.equal(get(id).status,'review');}finally{globalThis.fetch=old;}
});
