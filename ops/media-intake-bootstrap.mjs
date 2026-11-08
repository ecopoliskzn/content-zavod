// Настройка одного служебного потока на VPS. Роли утверждающих не расширяются.
// Тема создаётся один раз; неизвестный исход создания не повторяется автоматически.
import {existsSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {dataPath,env,list,wrongUser} from '../src/lib/env.mjs';
import {readJson,lock} from '../src/lib/files.mjs';import {tg} from '../src/lib/telegram.mjs';
import {admin} from '../src/bot/media-intake-runtime.mjs';
if(wrongUser())throw Error('запускается пользователем завода');
const author=process.argv.find(a=>a.startsWith('--author-id='))?.slice(12);
if(!author||!/^\d+$/.test(author)||!process.argv.includes('--enable'))throw Error('нужны проверенный author-id и --enable');
const dir=dataPath('media-intake');mkdirSync(dir,{recursive:true,mode:0o700});
const marker=dataPath('media-intake','bootstrap.json');const save=v=>{writeFileSync(marker+'.tmp',JSON.stringify(v),{mode:0o600});renameSync(marker+'.tmp',marker);};
const unlock=lock(dataPath('media-intake','bootstrap.lock'),120000);if(!unlock)throw Error('настройка занята');
try{
 const api=async(method,body)=>{const r=await tg(method,body,{retries:0});if(r.kind!=='ok'||!r.data?.ok)throw Error('Telegram readiness failed');return r.result;};
 const me=await api('getMe',{}),group=env('TG_GROUP_ID'),member=await api('getChatMember',{chat_id:group,user_id:me.id});
 if(!['administrator','creator'].includes(member.status)||member.can_manage_topics===false)throw Error('нет права служебной темы');
 const channel=await api('getChatMember',{chat_id:env('TG_CHANNEL'),user_id:me.id});
 if(!['administrator','creator'].includes(channel.status)||channel.can_post_messages===false)throw Error('нет права канала');
 if(!list('APPROVER_IDS').length||!env('VK_GROUP_ID')||!env('TG_TOPIC_PACKAGES'))throw Error('не хватает ролей или ручного пути VK');
 if(env('VK_USER_TOKEN'))throw Error('путь VK изменился: требуется проверка режима API');
 let state=readJson(marker,{});
 if(!state.topicId){
  if(state.phase==='creating'||state.phase==='unknown')throw Error('нужна сверка ранее созданной темы');
  save({phase:'creating',at:new Date().toISOString()});
  let topic;try{topic=await api('createForumTopic',{chat_id:group,name:'Материалы'});}catch{save({phase:'unknown',at:new Date().toISOString()});throw Error('исход создания темы неизвестен');}
  if(!Number.isSafeInteger(topic.message_thread_id))throw Error('нет ID темы');
  state={phase:'created',topicId:topic.message_thread_id,at:new Date().toISOString()};save(state);
 }
 const at=new Date().toISOString();
 const config={enabled:true,groupId:group,topicId:state.topicId,authors:[...new Set([...list('STAFF_IDS'),...list('APPROVER_IDS'),author])],coordinators:[],coordinatorMode:'operator-admin',approvers:list('APPROVER_IDS'),handoffMode:'B',policyVersion:'intake-pilot-v4-2026-11-07',
  authorEvidence:{[author]:'operator-provided Telegram ID, 2026-10-17'},targets:[
   {channel:'telegram',account_ref:'configured-tg-channel',format:'album',delivery_mode:'auto',readiness:'passed',verified_at:at},
   {channel:'vk',account_ref:'configured-vk-community',format:'photopost',delivery_mode:'manual',readiness:'passed',verified_at:at}],
  limits:{maxFiles:10,maxBytes:20*1024**2,maxPending:20,maxText:4000,maxJobInput:24000,maxJobOutput:24000,maxCalls:4},quietMs:2000,rightsPolicy:null};
 const result=await admin('intake-configure',{config},'operator-bootstrap');if(result.code!==0)throw Error('конфигурация отклонена');
 console.log(JSON.stringify({ok:true,enabled:true,topicId:state.topicId,authorCount:config.authors.length,approverCount:config.approvers.length,coordinatorMode:config.coordinatorMode,handoffMode:'B',targets:[{channel:'telegram',delivery:'auto'},{channel:'vk',delivery:'manual'}],publicationsSent:0}));
}finally{unlock();}
