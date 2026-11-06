import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const dir=mkdtempSync(path.join(tmpdir(),'review-guidance-'));
process.env.DATA_DIR=dir;process.env.ZAVOD_ENV_FILE=path.join(dir,'absent.env');
process.env.TG_BOT_TOKEN='synthetic';process.env.TG_GROUP_ID='-1001';process.env.APPROVER_IDS='42';
delete process.env.TG_RELAY_URL;delete process.env.QUEUE_API_BASE;
const calls=[],messages=new Map();let next=100;
globalThis.fetch=async(url,init)=>{
 const method=String(url).split('/').pop(),body=JSON.parse(init?.body||'{}');calls.push({method,body});
 if(method==='sendMessage'){const result={message_id:++next,chat:{id:-1001}};messages.set(next,body);return Response.json({ok:true,result});}
 if(method==='editMessageText')messages.set(body.message_id,body);
 return Response.json({ok:true,result:true});
};
const store=await import('../src/queue/store.mjs'),approval=await import('../src/bot/approval.mjs');
const entry=async name=>approval.submit((await store.put({channel:'telegram',kind:'post',name,material:'blog:'+name,date:'2030-06-01',time:'12:00',text:`«${name}»: ровность покрытия проверяют правилом. Зазоры отмечают при осмотре.`})).entry.id);
const reply=e=>({text:'Заменить «при осмотре» на «при приёмке».',chat:{id:-1001},from:{id:42,first_name:'approver'},reply_to_message:{message_id:e.approval.card.messageId}});
const tapFix=e=>approval.handleCallback({id:'synthetic',data:messages.get(e.approval.card.messageId).reply_markup.inline_keyboard.flat().find(b=>b.callback_data.startsWith('q:fix:')).callback_data,from:{id:42,first_name:'approver'},message:{message_id:e.approval.card.messageId,chat:{id:-1001}}});

test('«Правка» оставляет понятную инструкцию в карточке и не требует закрывать модальное OK',async()=>{
 const e=await entry('guidance');
 const data=messages.get(e.approval.card.messageId).reply_markup.inline_keyboard.flat().find(b=>b.callback_data.startsWith('q:fix:')).callback_data;
 calls.length=0;
 await approval.handleCallback({id:'synthetic',data,from:{id:42,first_name:'approver'},message:{message_id:e.approval.card.messageId,message_thread_id:77,chat:{id:-1001}}});
 const text=messages.get(e.approval.card.messageId).text;
 assert.match(text,/Режим правки включён/);assert.match(text,/Теперь напишите свои замечания/);assert.match(text,/Весь текст поста копировать не нужно/);
 assert.equal(calls.some(c=>c.method==='answerCallbackQuery'&&c.body.show_alert===true),false);
 const prompt=calls.find(c=>c.method==='sendMessage'&&c.body.reply_markup?.force_reply);
 assert.ok(prompt);assert.equal(prompt.body.reply_markup.selective,true);assert.equal(prompt.body.message_thread_id,77);assert.equal(prompt.body.reply_parameters.message_id,e.approval.card.messageId);
 assert.match(prompt.body.text,/tg:\/\/user\?id=42/);
 assert.ok(store.get(e.id).fixAsked);
 const message={...reply(e),reply_to_message:{message_id:store.get(e.id).fixAsked.promptId}};
 await approval.handleReply(message);
 assert.equal(store.get(e.id).status,'rework');assert.equal(store.get(e.id).note,reply(e).text);
});

test('обычное обсуждение без включения режима не становится правкой',async()=>{
 const e=await entry('discussion');await approval.handleReply(reply(e));assert.equal(store.get(e.id).status,'review');
});

test('запросы замечания привязаны к своей записи и прежний запрос не меняет новую версию',async()=>{
 const a=await entry('prompt-a'),b=await entry('prompt-b');await tapFix(a);await tapFix(b);
 const aPrompt=store.get(a.id).fixAsked.promptId,bPrompt=store.get(b.id).fixAsked.promptId;
 assert.notEqual(aPrompt,bPrompt);
 await approval.handleReply({...reply(b),reply_to_message:{message_id:bPrompt}});
 assert.equal(store.get(b.id).status,'rework');assert.equal(store.get(a.id).status,'review');
 await approval.handleReply({...reply(a),chat:{id:-999},reply_to_message:{message_id:aPrompt}});
 assert.equal(store.get(a.id).status,'review');
 await store.put({...a,text:'«prompt-a»: после завершения работ проверили кромки покрытия.'});
 await approval.submit(a.id);
 assert.equal(await approval.handleReply({...reply(a),reply_to_message:{message_id:aPrompt}}),false);
 assert.equal(store.get(a.id).status,'review');
});
