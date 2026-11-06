// Удаляем только доказанные сообщения собственных согласований в рабочей теме.
// Текущий комплект любой незавершённой записи защищён целиком; при отказе Telegram
// оставляем сообщение и сохраняем результат, а не выдаём отказ за успешную очистку.
import {tg} from '../lib/telegram.mjs';
import {env} from '../lib/env.mjs';
import {all,history,patch} from '../queue/store.mjs';

const valid=id=>Number.isSafeInteger(Number(id))&&Number(id)>0;
export function approvalMessages(approval){
 const cardIds=[...new Set([approval?.card?.messageId,...(approval?.card?.messageIds||[])].filter(valid).map(Number))];
 return [...cardIds.map(id=>({id,type:'card'})),
 ...(approval?.preview?.messageIds||[]).filter(valid).map(id=>({id:Number(id),type:'preview'}))];
}
export function cleanupPlan(rows,current,scope){
 const protectedIds=new Set(current.filter(e=>!['published','cancelled'].includes(e.status)).flatMap(e=>approvalMessages(e.approval).map(m=>m.id)));
 const known=new Map();
 for(const e of rows)for(const receipt of [e.approval,...(e.approvalHistory||[])]){
  if(String(receipt?.groupId)!==String(scope.groupId)||Number(receipt?.topicId)!==Number(scope.topicId))continue;
  for(const m of approvalMessages(receipt)){
   const prior=known.get(m.id);known.set(m.id,{...m,owner:e.id,ambiguous:Boolean(prior&&(prior.owner!==e.id||prior.ambiguous))});
  }
 }
 return {candidates:[...known.values()].filter(m=>!protectedIds.has(m.id)&&!m.ambiguous),excluded:[...protectedIds]};
}

export async function cleanupStaleApprovals(id){
 const scope={groupId:env('TG_GROUP_ID'),topicId:Number(env('TG_TOPIC_APPROVAL'))};
 if(!scope.groupId||!scope.topicId)return {deleted:0,kept:0};
 const plan=cleanupPlan(history(id),all(),scope),results=[];
 const prior=all().find(e=>e.id===id)?.approvalCleanup||{};
 for(const item of plan.candidates){
  if(prior[item.id]?.deleted)continue;
  // Повторная сверка непосредственно перед удалением защищает текущие previews.
  if(!cleanupPlan(history(id),all(),scope).candidates.some(m=>m.id===item.id))continue;
  const r=await tg('deleteMessage',{chat_id:scope.groupId,message_id:item.id},{retries:0});
  const deleted=r.kind==='ok'&&r.data?.ok!==false;
  let buttonsRemoved=false;
  if(!deleted&&r.kind!=='network'&&item.type==='card'){
   const edit=await tg('editMessageReplyMarkup',{chat_id:scope.groupId,message_id:item.id,reply_markup:{inline_keyboard:[]}},{retries:0});
   buttonsRemoved=edit.kind==='ok'&&edit.data?.ok!==false;
  }
  results.push({id:item.id,deleted,buttonsRemoved,kind:r.kind,http:r.status||0});
 }
 if(results.length)await patch(id,{approvalCleanup:{...prior,...Object.fromEntries(results.map(r=>[r.id,r]))}},'очистка согласования');
 return {deleted:results.filter(r=>r.deleted).length,kept:results.filter(r=>!r.deleted).length};
}
