import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
process.env.DATA_DIR=mkdtempSync(path.join(tmpdir(),'approval-cleanup-'));process.env.ZAVOD_ENV_FILE=path.join(process.env.DATA_DIR,'absent.env');
process.env.TG_BOT_TOKEN='synthetic';process.env.TG_GROUP_ID='-1001';process.env.TG_TOPIC_APPROVAL='70';delete process.env.TG_RELAY_URL;delete process.env.QUEUE_API_BASE;
const {cleanupPlan}=await import('../src/bot/approval-cleanup.mjs');
const scope={groupId:'-1001',topicId:70};
const receipt=(card,images=[])=>({...scope,card:{messageId:card},preview:{messageIds:images}});
test('пять комплектов: текущий альбом и карточка защищены, другие записи не затрагиваются',()=>{
 const rows=Array.from({length:5},(_,i)=>({id:'a',approval:receipt(100+i,[200+i*2,201+i*2])}));
 const current=[rows[4],{id:'b',approval:receipt(500,[501,502])},{id:'c',approval:receipt(600)}].map(e=>({...e,status:'review'}));
 const p=cleanupPlan(rows,current,scope);
 assert.equal(p.candidates.length,12);assert.ok(p.excluded.includes(104));assert.ok(p.excluded.includes(208));
 assert.ok(!p.candidates.some(m=>[104,208,209,500,501,502,600].includes(m.id)));
});
test('история сохраняет ID, чужая тема и неоднозначные ID остаются',()=>{
 const rows=[{id:'a',approvalHistory:[receipt(100,[101])],approval:receipt(200)},{id:'b',approval:receipt(100)},{id:'x',approval:{...receipt(900),topicId:71}}];
 const p=cleanupPlan(rows,[{...rows[0],status:'review'}],scope);
 assert.deepEqual(p.candidates.map(m=>m.id),[101]);
});

const store=await import('../src/queue/store.mjs'),approval=await import('../src/bot/approval.mjs');
const calls=[];let sequence=1000,failCard=false,refuseDelete=false;
globalThis.fetch=async(url,opts)=>{
 if(String(url).startsWith('https://example.org/'))return new Response('synthetic photo');
 const method=String(url).split('/').pop(),body=typeof opts.body==='string'?JSON.parse(opts.body):opts.body;
 calls.push({method,body});
 if(method==='sendMessage'&&failCard||method==='deleteMessage'&&refuseDelete)return Response.json({ok:false,error_code:400,description:'synthetic refused'},{status:400});
 if(method==='sendMediaGroup')return Response.json({ok:true,result:[0,1].map(()=>({message_id:++sequence,media_group_id:'g',photo:[{}],chat:{id:-1001}}))});
 return Response.json({ok:true,result:method==='sendMessage'?{message_id:++sequence}:true});
};
const raw=name=>({channel:'telegram',kind:'post',name,material:'case:'+name,text:`«${name}»: примыкания осматривают после завершения работ.`,date:'2030-06-01',time:'12:00',media:[{type:'image',url:'https://example.org/one.jpg'},{type:'image',url:'https://example.org/two.jpg'}]});

test('пять повторов submit и правка тайминга не создают новый альбом или карточку',async()=>{
 const e=(await store.put(raw('repeat'))).entry;await approval.submit(e.id);const before=store.get(e.id),hash=before.contentHash;
 calls.length=0;for(let i=0;i<5;i++)await approval.submit(e.id);
 await store.reschedule(e.id,'2030-06-02','15:00','test',{}, {mode:'after-approval'});await approval.refreshCard(e.id);
 assert.equal(calls.filter(c=>['sendMessage','sendMediaGroup','deleteMessage'].includes(c.method)).length,0);
 assert.equal(store.get(e.id).contentHash,hash);assert.equal(store.get(e.id).approval.card.messageId,before.approval.card.messageId);
});

test('новая версия: при ошибке доставки старый комплект остаётся; после успеха удаляется только старый',async()=>{
 const e=(await store.put(raw('replacement'))).entry;await approval.submit(e.id);const previous=store.get(e.id),oldIds=[previous.approval.card.messageId,...previous.approval.preview.messageIds.map(Number)];
 await store.put({...raw('replacement'),text:'Кромки осматривают после завершения работ.'});calls.length=0;failCard=true;
 await assert.rejects(()=>approval.submit(e.id));failCard=false;
 assert.equal(calls.some(c=>c.method==='deleteMessage'),false);
 assert.ok(store.get(e.id).approvalHistory.some(r=>r.card?.messageId===oldIds[0]));
 const {execute}=await import('../src/queue/commands.mjs');assert.equal((await execute('preview-reset',{ref:e.id,'confirm-card-absent':true})).code,0);
 calls.length=0;await approval.submit(e.id);const current=store.get(e.id),deleted=calls.filter(c=>c.method==='deleteMessage').map(c=>c.body.message_id);
 for(const id of oldIds)assert.ok(deleted.includes(id),String(id));
 assert.ok(!deleted.includes(current.approval.card.messageId));for(const id of current.approval.preview.messageIds)assert.ok(!deleted.includes(Number(id)));
});

test('отказ delete не снимает действующее согласование и не объявляется удалением',async()=>{
 const e=(await store.put(raw('delete-refused'))).entry;await approval.submit(e.id);const old=store.get(e.id).approval.card.messageId;
 await store.put({...raw('delete-refused'),text:'Покрытие осматривают у примыкания.'});refuseDelete=true;
 try{await approval.submit(e.id);}finally{refuseDelete=false;}
 assert.equal(store.get(e.id).status,'review');assert.equal(store.get(e.id).approvalCleanup[old].deleted,false);
});
