// Заголовок и текст ручного пакета имеют отдельные долговечные квитанции.
// Отказ одного сообщения не делает пакет переданным. Неизвестный ACK удерживается;
// уже доставленные части повторно не отправляются даже после рестарта runner.
import {createHash} from 'node:crypto';import {chunks,h} from '../lib/telegram.mjs';
const fail=(error,retry=false)=>({ok:false,error,retry});
export async function deliverManual(entry,{kind,head,body,buttons,onState,deliver}){
 if(!onState)return fail('Ручной пакет требует долговечной квитанции очереди.');
 const hash=createHash('sha256').update(JSON.stringify([kind,entry.id,entry.contentHash||'',entry.text||'',entry.posts||[],entry.title||''])).digest('hex');
 let state=entry.result?.manualDelivery?structuredClone(entry.result.manualDelivery):null;
 if(!state&&entry.result?.packageMessageId)return fail('У прежнего пакета сохранён только заголовок; доставку текста нужно сверить вручную.');
 if(state&&(state.schema!==1||state.kind!==kind||state.hash!==hash))return fail('Содержимое ручного пакета изменилось; прежняя доставка требует сверки.');
 state||={schema:1,kind,hash,head:{index:0,ids:[],status:'pending'},body:{index:0,ids:[],status:'pending'},complete:false};
 const persist=()=>onState({...(state.head.ids.length?{packageMessageId:state.head.ids.at(-1)}:{}),manualDelivery:structuredClone(state)});
 if([state.head.status,state.body.status].some(s=>['sending','unknown'].includes(s))){state.unknown=true;await persist();return fail('Отправка ручного пакета имеет неизвестный исход; проверьте доставку, автоматический повтор запрещён.');}
 if(state.complete)return{ok:true,manual:true,note:'Полный ручной пакет уже доставлен; ожидает отметки человека.'};
 const parts={head:chunks(head),body:body?chunks(h(body)):[]};
 for(const section of ['head','body']){
  const progress=state[section];
  for(let i=progress.index;i<parts[section].length;i++){
   progress.status='sending';await persist();let result;
   try{result=await deliver('packages',parts[section][i],{retries:0,...(section==='head'&&i===parts.head.length-1?{buttons}:{}),...(section==='body'?{extra:{reply_parameters:{message_id:state.head.ids.at(-1)}}}:{})});}catch{result={ok:false,kind:'network'};}
   if(!result.ok||!Number.isSafeInteger(result.messageId)||result.messageId<=0){
    const refused=result.ok===false&&result.kind==='refused';progress.status=refused?'pending':'unknown';await persist();
    return fail(refused?'Telegram отказал в доставке части ручного пакета; передано не всё.':'Исход отправки части ручного пакета неизвестен; повтор удержан до сверки.',refused);
   }
   progress.ids.push(result.messageId);progress.index=i+1;progress.status='pending';await persist();
  }
  progress.status='sent';await persist();
 }
 state.complete=true;await persist();return{ok:true,manual:true,note:'Полный ручной пакет доставлен; ожидает отметки человека.'};
}
