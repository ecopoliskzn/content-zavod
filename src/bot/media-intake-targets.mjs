// Формат задания и состав файлов проверяются без модели. Схема не доказывает
// доступность API: готовность конкретного аккаунта/медиапути подтверждает S0.
import {createHash} from 'node:crypto';
import {KINDS} from '../queue/format.mjs';
const SPECS={
 text:{kind:'post',media:'none',channels:['telegram','vk','bot'],label:'текст'},
 post:{kind:'post',media:'optional-image',channels:['telegram','vk','bot'],label:'пост'},
 thread:{kind:'thread',media:'optional-image',channels:['threads'],label:'ветка'},
 article:{kind:'article',media:'optional-image',channels:['dzen'],label:'статья'},
 album:{kind:'post',media:'image',channels:['telegram'],label:'альбом',min:1,max:10},
 photopost:{kind:'post',media:'image',channels:['vk'],label:'пост с фото',min:1,max:10},
 'photo-post':{kind:'post',media:'image',channels:['vk'],label:'пост с фото',min:1,max:10},
 carousel:{kind:'carousel',media:'image',channels:['instagram'],label:'карусель',min:2,max:10},
 video:{kind:'video',media:'video',channels:['youtube','vk','rutube','telegram'],label:'видео',min:1,max:1},
 short:{kind:'short',media:'video',channels:['youtube','rutube'],label:'короткое видео',min:1,max:1},
 reel:{kind:'reel',media:'video',channels:['instagram'],label:'рилс',min:1,max:1},
 story:{kind:'story',media:'image-or-video',channels:['instagram'],label:'сторис',min:1,max:1},
};
export const channelTitle=c=>({telegram:'Telegram',vk:'ВКонтакте',threads:'Threads',dzen:'Дзен',instagram:'Instagram',youtube:'YouTube',rutube:'Rutube',bot:'Рассылка в боте'})[c]||c;
export const targetKey=t=>`${t.channel}:${t.format}`;
export const targetToken=t=>createHash('sha256').update(targetKey(t)).digest('hex').slice(0,10);
export function targetEntryName(job,t){const suffix=job.targets.filter(x=>x.channel===t.channel).length>1?'-'+targetToken(t).slice(0,6):'';const name=`mi-${job.materialId}-${job.revision}${suffix}`;if(name.length>32)throw Error('ревизия превышает длину имени записи');return name;}
export function targetSpec(t){const s=SPECS[t?.format],kind=t?.format==='video'&&t.channel==='telegram'?'post':s?.kind;return s&&s.channels.includes(t.channel)&&KINDS[t.channel]?.includes(kind)?{...s,kind}:null;}
export function targetFiles(t,files){const s=targetSpec(t),available=files.filter(f=>!f.excluded&&f.status==='verified');if(!s)return[];
 if(s.media==='none')return[];
 if(s.media==='video')return available.filter(f=>f.mime?.startsWith('video/'));
 if(s.media==='image-or-video')return available.filter(f=>/^(image|video)\//.test(f.mime||''));
 return available.filter(f=>f.mime?.startsWith('image/'));
}
export function targetProblems(t,files){
 const s=targetSpec(t),problems=[];if(!s)return[{code:'unsupported_target',reason:'Формат не поддерживается этой площадкой'}];
 if(!t.account_ref||!['auto','manual'].includes(t.delivery_mode))problems.push({code:'target_path_missing',reason:'Не указан аккаунт или способ доставки'});
 if(t.readiness!=='passed'||!Number.isFinite(Date.parse(t.verified_at||'')))problems.push({code:'target_not_ready',reason:t.reason||'Медиапуть этой площадки ещё не проверен'});
 const count=targetFiles(t,files).length;
 if(s.min&&count<s.min)problems.push({code:s.media==='video'?'video_required':'photo_required',reason:s.media==='video'?'Нужно подходящее видео':`Нужно фото/вложений: не меньше ${s.min}`});
 if(s.max&&count>s.max)problems.push({code:'asset_selection_required',reason:`Выберите не больше ${s.max} вложений для этого варианта`});
 if(t.channel==='bot'&&t.delivery_mode!=='auto')problems.push({code:'unsupported_target',reason:'Рассылка работает только через штатный серверный адаптер'});
 return problems;
}
export function chooseTargets(registry,files){
 const out=[],hasVisual=files.some(f=>!f.excluded&&f.status==='verified');
 for(const t of registry||[]){if(targetProblems(t,files).length)continue;const spec=targetSpec(t);
  // Визуальный комплект не превращаем молча в лишние текстовые версии; их можно выбрать явно.
  if(hasVisual&&spec.media==='none')continue;
  if(out.some(x=>targetKey(x)===targetKey(t)))continue;out.push(structuredClone(t));
 }return out;
}
export const recipientFor=targets=>targets.some(t=>['video','short','reel'].includes(t.format)||t.format==='story'&&t.mediaKind==='video')?'S2':'S1';
export function validateTarget(t){return Boolean(targetSpec(t)&&t.account_ref&&['auto','manual'].includes(t.delivery_mode)&&['passed','not_ready'].includes(t.readiness)&&(t.readiness==='passed'?Number.isFinite(Date.parse(t.verified_at||'')):typeof t.reason==='string'&&t.reason.trim()));}
