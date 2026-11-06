import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'approval-isolation-'));process.env.DATA_DIR=dir;process.env.ZAVOD_ENV_FILE=path.join(dir,'absent.env');
process.env.TG_BOT_TOKEN='synthetic';process.env.TG_GROUP_ID='-1001';process.env.APPROVER_IDS='42';delete process.env.TG_RELAY_URL;
const messages=new Map(),calls=[];let next=100;
globalThis.fetch=async(url,init)=>{
 const method=String(url).split('/').pop(),body=typeof init?.body==='string'?JSON.parse(init.body):{};calls.push({method,body});
 if(method==='sendMessage'){const result={message_id:++next,chat:{id:-1001}};messages.set(next,{...body});return Response.json({ok:true,result});}
 if(method==='editMessageText')messages.set(body.message_id,{...body});
 return Response.json({ok:true,result:true});
};
const store=await import('../src/queue/store.mjs');const approval=await import('../src/bot/approval.mjs');
const raw=(name,channel='telegram')=>({channel,kind:channel==='threads'?'thread':'post',name,material:'blog:'+name,date:'2030-06-01',time:'12:00',...(channel==='threads'?{posts:[`«${name}»: ровность покрытия проверяют правилом. Зазоры отмечают при осмотре.`]}:{text:`«${name}»: ровность покрытия проверяют правилом. Зазоры отмечают при осмотре.`})});
const button=(e,action)=>messages.get(e.approval.card.messageId).reply_markup.inline_keyboard.flat().find(b=>b.callback_data?.startsWith(`q:${action}:`))?.callback_data;
const tap=(e,action,{data=button(e,action),messageId=e.approval.card.messageId,chat=-1001}={})=>approval.handleCallback({id:'synthetic',data,from:{id:42,first_name:'approver'},message:{message_id:messageId,chat:{id:chat}}});
async function create(name,channel){const e=(await store.put(raw(name,channel))).entry;return approval.submit(e.id);}
test('три карточки независимы, включая одинаковое имя на разных площадках',async()=>{
 const a=await create('same'),b=await create('same','vk'),c=await create('third','threads');
 const beforeB=JSON.stringify(messages.get(b.approval.card.messageId)),beforeC=JSON.stringify(messages.get(c.approval.card.messageId));
 await tap(a,'ok');assert.equal(store.get(a.id).status,'approved');assert.equal(store.get(b.id).status,'review');assert.equal(store.get(c.id).status,'review');
 assert.equal(JSON.stringify(messages.get(b.approval.card.messageId)),beforeB);assert.equal(JSON.stringify(messages.get(c.approval.card.messageId)),beforeC);
 await tap(b,'ok');await tap(c,'ok');for(const e of [a,b,c])assert.ok(button(store.get(e.id),'undo'));
 await tap(store.get(b.id),'undo');assert.equal(store.get(b.id).status,'review');assert.equal(store.get(a.id).status,'approved');assert.equal(store.get(c.id).status,'approved');
 await tap(store.get(c.id),'no');assert.equal(store.get(c.id).status,'cancelled');assert.ok(button(store.get(a.id),'undo'));assert.ok(button(store.get(b.id),'ok'));
});
test('старый отзыв/снятие не воздействуют на новую версию, чужой chat и нет message дают отказ',async()=>{
 let e=await create('changed');await tap(e,'ok');e=store.get(e.id);const oldUndo=button(e,'undo'),oldNo=button(e,'no'),oldCard=e.approval.card.messageId;
 await store.put({...raw('changed'),text:'Примыкания осмотрели после завершения работ. Теперь проверяем кромки.'});await approval.submit(e.id);e=store.get(e.id);await tap(e,'ok');e=store.get(e.id);
 await tap(e,'undo',{data:oldUndo,messageId:oldCard});assert.equal(store.get(e.id).status,'approved');
 if(oldNo)await tap(e,'no',{data:oldNo,messageId:oldCard});assert.equal(store.get(e.id).status,'approved');
 await tap(e,'undo',{chat:-999});assert.equal(store.get(e.id).status,'approved');
 await approval.handleCallback({id:'missing',data:button(e,'undo'),from:{id:42}});assert.equal(store.get(e.id).status,'approved');
});
test('ответ «одобрить» на карточку не является замечанием и не меняет ни один статус',async()=>{
 const e=await create('text-approve'),before=store.all().map(x=>[x.id,x.status]);
 await approval.handleReply({text:'одобрить',chat:{id:-1001},from:{id:42},reply_to_message:{message_id:e.approval.card.messageId}});
 await approval.handleReply({text:'одобрить',chat:{id:-1001},from:{id:42},reply_to_message:{message_id:99999}});
 assert.deepEqual(store.all().map(x=>[x.id,x.status]),before);assert.ok(calls.some(x=>x.method==='sendMessage'&&/кнопк/.test(x.body.text||'')));
});
test('неоднозначный messageId и повреждённый callback не выбирают запись наугад',async()=>{
 const a=await create('ambiguous-a'),b=await create('ambiguous-b'),original=b.approval.card;
 try{await store.patch(b.id,{approval:{...b.approval,card:a.approval.card}});await tap(a,'ok');assert.equal(store.get(a.id).status,'review');assert.equal(store.get(b.id).status,'review');
  await approval.handleCallback({id:'bad',data:'q:ok:ambiguous-a',from:{id:42},message:{message_id:a.approval.card.messageId,chat:{id:-1001}}});assert.equal(store.get(a.id).status,'review');
 }finally{await store.patch(b.id,{approval:{...b.approval,card:original}});}
});
test('задержанный повтор отзыва не отменяет повторное согласование той же карточки',async()=>{
 let e=await create('same-version');await tap(e,'ok');e=store.get(e.id);const undo=button(e,'undo');await tap(e,'undo',{data:undo});
 await tap(store.get(e.id),'ok');await tap(store.get(e.id),'undo',{data:undo});assert.equal(store.get(e.id).status,'approved');
});
test('одновременный двойной callback и обновление кнопок не меняют другие записи',async()=>{
 let e=await create('concurrent');const data=button(e,'ok');await Promise.all([tap(e,'ok',{data}),tap(e,'ok',{data})]);assert.equal(store.get(e.id).status,'approved');
 const before=store.all().filter(x=>x.id!==e.id).map(x=>[x.id,x.status,x.approval?.actionToken]);e=store.get(e.id);const old=button(e,'undo'),approvalAt=e.approval.at,hash=e.contentHash;
 await approval.refreshCard(e.id);e=store.get(e.id);assert.equal(e.approval.at,approvalAt);assert.equal(e.contentHash,hash);assert.ok(button(e,'no'));await tap(e,'undo',{data:old});assert.equal(store.get(e.id).status,'approved');
 assert.deepEqual(store.all().filter(x=>x.id!==e.id).map(x=>[x.id,x.status,x.approval?.actionToken]),before);
});
test('просроченный callback Telegram не записывает решение',async()=>{
 const e=await create('expired-query'),old=globalThis.fetch;
 globalThis.fetch=async(url,init)=>String(url).endsWith('/answerCallbackQuery')?Response.json({ok:false,error_code:400,description:'query is too old and response timeout expired'},{status:400}):old(url,init);
 try{await tap(e,'ok');assert.equal(store.get(e.id).status,'review');}finally{globalThis.fetch=old;}
});
