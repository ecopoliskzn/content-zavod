// Согласование: карточка в рабочей группе Telegram и кнопки под ней.
//
// КТО ГОВОРИТ «ДА». Ответственный со стороны клиента. Его числовой id Telegram лежит в
// APPROVER_IDS; нажатие любого другого участника группы бот вежливо отклоняет. Имя и
// время согласия записываются в запись очереди: если публикацию оспорят, видно, кто и
// какой текст одобрил.
//
// ЧТО ВИДИТ ЧЕЛОВЕК. Текст ровно таким, каким он уйдёт на площадку, слот, из чего
// сделан материал, вердикт проверок и источники цифр. Карточка читается с телефона:
// согласование не должно требовать компьютера.
//
// КНОПКИ:
//   Одобрить — запись встаёт в расписание. Если слот уже прошёл, бот сам ставит её
//              в ближайший свободный и пишет, в какой;
//   Правка   — бот просит ответить на карточку сообщением. Текст ответа уходит оператору;
//   Снять    — запись не выйдет;
//   Отозвать — передумали после «да», пока запись не вышла.
//
// РОЛИК YOUTUBE С ДАТОЙ ВЫХОДА. Он загружен закрытым, и YouTube откроет его сам, что бы ни
// стало с записью. Поэтому «Снять», «Отозвать» и правка сразу снимают срок на YouTube, а
// человеку пишется, что получилось: «не выйдет» говорится только по ответу YouTube.
// Подробно: src/video/schedule.mjs.
//
// ПРАВКА ТЕКСТА ПОСЛЕ «ДА» СОГЛАСИЕ СНИМАЕТ: запись возвращается в черновики и приходит
// новой карточкой. Человек говорил «да» другому тексту.

import { channel as channelCfg } from "../lib/config.mjs";
import { list,env } from "../lib/env.mjs";
import { groupId, h, toGroup } from "../lib/notify.mjs";
import { answerCallback, editMessageText, keyboard,sendMessage,chunks } from "../lib/telegram.mjs";
import { dueAt, human } from "../lib/time.mjs";
import { check } from "../gates/index.mjs";
import { STATUS_TITLE, preview } from "../queue/format.mjs";
import { slotFor } from "../queue/slots.mjs";
import { RuleError, all, get, patch, reschedule, transition,approveEntry } from "../queue/store.mjs";
import {previewPhotos} from './approval-photos.mjs';
import {cleanupStaleApprovals} from './approval-cleanup.mjs';
import {compactCardText} from './approval-card-view.mjs';
import {lock} from '../lib/files.mjs';
import {dataPath} from '../lib/env.mjs';
import { stopState } from "../queue/switch.mjs";
import {randomBytes} from 'node:crypto';
import { afterChange as syncYoutube } from "../video/schedule.mjs";

/*
 * ПЕРЕХВАТ РАСПИСАНИЯ. Пока расписание ведёт компьютер оператора, кнопки по-прежнему
 * обрабатывает сервер, а выпускает не он. Решение человека доходит до компьютера при
 * сверке раз в пять минут, а новое «да» не доходит вовсе: компьютер выпускает только
 * одобренное до аварии. Отвечать при этом «Не выйдет» и «Выйдет в 14:30» было бы
 * неправдой, поэтому в ответ дописывается, как обстоит дело.
 */
const lagNote = (wasApproved) => (wasApproved && stopState().takeover ? " Расписание сейчас ведёт компьютер оператора: о вашем решении он узнаёт при сверке с сервером, в пределах пяти минут. Если слот записи в эти минуты, она ещё может выйти." : "");
const waitNote = () => (stopState().takeover ? " Расписание сейчас ведёт компьютер оператора, и новые согласия он не принимает: запись выйдет, когда расписание вернётся серверу." : "");

export const approvers = () => list("APPROVER_IDS");
const isApprover = (userId) => approvers().includes(String(userId));
const who = (from) => [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || String(from?.id || "");

const newToken=()=>randomBytes(8).toString('hex');
const data=(e,action)=>`q:${action}:${e.id}:${e.approval.actionToken}`;
const BUTTONS = e => [[{ text: "✅ Одобрить", data: data(e,'ok') }, { text: "✏️ Исправить", data: data(e,'fix') }, { text: "🚫 Отменить", data: data(e,'no') }]];
const UNDO = e => [[{ text: "↩️ Отозвать согласие", data: data(e,'undo') },{text:'🚫 Отменить',data:data(e,'no')}]];
const activeButtons=e=>e.status==='approved'?UNDO(e):['failed','expired'].includes(e.status)?[[{text:'Повторить выпуск',data:data(e,'next')},{text:'🚫 Отменить',data:data(e,'no')}]]:['draft','review'].includes(e.status)?BUTTONS(e):null;

/** Текст карточки: содержимое как на площадке плюс всё, что нужно для решения. */
export const cardText=compactCardText;

/**
 * Отправить запись на согласование: проверки, карточка в группу, статус «ждёт согласования».
 * Отказ по правилу (RuleError), если проверки не пройдены: в группу уходит только то,
 * что можно выпускать.
 */
export async function submit(id, by = "оператор") {
  const unlock=lock(dataPath('approval-locks',`${id}.lock`),60*60*1000);if(!unlock)throw new RuleError('отправка карточки уже выполняется');
  try {
  let entry = get(id);
  if (!entry) throw new RuleError(`записи ${id} нет в очереди`);
  if(['review','approved'].includes(entry.status)&&entry.approval?.card?.messageId&&entry.approval.cardHash===entry.contentHash){
    // Повтор submit неизменного материала — обновление текущей карточки, не новый альбом.
    return refreshCard(id,by);
  }
  if (!["draft", "rework"].includes(entry.status)) throw new RuleError(`запись в статусе «${STATUS_TITLE[entry.status]}», на согласование уходят черновики`);
  const verdict = check(entry);
  if (verdict.block.length) throw new RuleError(`проверки не пройдены:\n- ${verdict.block.join("\n- ")}`);
  if(entry.approval?.card?.messageId&&entry.approval.cardHash===entry.contentHash&&(!(entry.media||[]).some(m=>m.type==='image')||entry.approval.preview?.complete&&entry.approval.preview.hash===entry.contentHash)){
    entry=await transition(id,'review',{note:undefined,fixAsked:undefined},by);
    return refreshCard(id,by);
  }
  const submittedHash=entry.contentHash;
  const preview=await previewPhotos(entry,entry.approval?.preview,async state=>{entry=await patch(id,{approval:{...(entry.approval||{}),preview:state}},by);});
  if(preview&&(get(id)?.contentHash!==submittedHash||preview.hash!==submittedHash))throw new RuleError('материал изменился при отправке фото; нужна новая карточка согласования');
  if(preview&&entry.approval?.cardSending)throw new RuleError('доставка кнопочной карточки неоднозначна; сначала нужна проверка оператором');
  if(preview&&entry.approval?.card?.messageId&&entry.approval?.cardHash===entry.contentHash)return transition(id,'review',{note:undefined},by);
  entry=await patch(id,{approval:{...(entry.approval||{}),groupId:String(groupId()),topicId:Number(env('TG_TOPIC_APPROVAL'))||0,actionToken:newToken(),...(preview?{cardSending:true}:{})}},by);
  const sent = await toGroup("approval", cardText(entry, verdict), { buttons: BUTTONS(entry),retries:0,...(preview?{extra:{reply_parameters:{message_id:Number(preview.messageIds[0])}}}:{}) });
  if (!sent.ok) throw Object.assign(new Error(`карточка не ушла в группу: ${sent.error}`), { code: "ENV" });
  if(!Number.isSafeInteger(sent.messageId)||sent.messageId<=0)throw Object.assign(new Error('Telegram не подтвердил ID кнопочной карточки; повтор требует проверки'),{code:'ENV'});
  if(all().some(e=>e.id!==id&&e.approval?.card?.messageId===sent.messageId))throw Object.assign(new Error('ID карточки уже принадлежит другой записи; требуется проверка'),{code:'ENV'});
  if(get(id)?.contentHash!==submittedHash){await retireCard({...entry,approval:{card:{messageId:sent.messageId}}});throw new RuleError('материал изменился при отправке карточки; старые кнопки сняты');}
  const approval={...(entry.approval||{}),card:{messageId:sent.messageId,messageIds:sent.messageIds},cardHash:entry.contentHash,cardSending:false,sentAt:new Date().toISOString()};
  if(preview)await patch(id,{approval},by);
  const current=await transition(entry.id, "review", { approval, note: undefined, nudged: false, fixAsked: undefined }, by);
  await cleanupStaleApprovals(id);
  return get(current.id);
  } finally {unlock();}
}

async function redraw(entry, footer, buttons) {
  const messageId = entry.approval?.card?.messageId;
  if (!messageId) return;
  const parts=chunks(cardText(entry,check(entry),footer)),ids=entry.approval.card.messageIds?.length?entry.approval.card.messageIds:[messageId];
  if(parts.length!==ids.length)throw Object.assign(new Error('изменилось число частей карточки; автоматическое обрезание текста запрещено, нужен разбор оператором'),{code:'ENV'});
  for(let i=0;i<parts.length;i++){
    const res=await editMessageText(groupId(),ids[i],parts[i],i===parts.length-1&&buttons?keyboard(buttons):{reply_markup:{inline_keyboard:[]}});
    if(res.kind!=='ok'&&!/message is not modified/i.test(res.error||''))throw Object.assign(new Error('карточка не обновилась; её текст сохранён, повторите refresh-card'),{code:'ENV'});
  }
}

/**
 * Текст записи изменили после отправки карточки: прежняя карточка больше не действует.
 * С неё снимаются кнопки и дописывается, что решение ждёт новой. Нажатие под ней бот и
 * так не примет; здесь убирается сама возможность перепутать.
 * @param {object} before запись, какой она была до правки (с номером своей карточки)
 */
export async function retireCard(before) {
  if (!before?.approval?.card?.messageId) return;
  await redraw(before, "✏️ Текст записи изменён: эта карточка больше не действует. Новая придёт следом в эту тему.", null).catch((e) => console.error("[approval] прежняя карточка не обновилась:", e?.message || e));
}

/** Обновить только конкретную существующую карточку, не менять согласие или статус. */
export async function refreshCard(id,by='оператор'){
  const unlock=lock(dataPath('approval-actions',`${id}.lock`),120000);if(!unlock)throw new RuleError('эта карточка уже обрабатывается');
  try{
    let entry=get(id);if(!entry||!entry.approval?.card?.messageId)throw new RuleError('обновляется только существующая карточка');
    if(all().some(e=>e.id!==id&&e.approval?.card?.messageId===entry.approval.card.messageId))throw new RuleError('ID карточки неоднозначен; обновление остановлено');
    if(['review','approved'].includes(entry.status)&&(entry.media||[]).some(m=>m.type==='video')&&!(entry.approval.preview?.complete&&entry.approval.preview.hash===entry.contentHash)){
      const hash=entry.contentHash;
      await previewPhotos(entry,entry.approval.preview,async preview=>{entry=await patch(id,{approval:{...entry.approval,preview}},by,{contentHash:hash});});
    }
    const current=await patch(id,{approval:{...entry.approval,actionToken:newToken(),cardHash:entry.contentHash}},by,{contentHash:entry.contentHash,card:entry.approval.card.messageId});
    await redraw(current,'',activeButtons(current));
    return current;
  }finally{unlock();}
}

/**
 * Нажатие кнопки под карточкой. Возвращает true, если нажатие наше (q:…).
 * @param {{ id: string, data: string, from: object, message?: object }} cb
 */
export async function handleCallback(cb) {
  const m = String(cb.data || "").match(/^q:(ok|fix|no|undo|next):([0-9a-f]{16})(?::([0-9a-f]{16}))?$/);
  if (!m){if(String(cb.data||'').startsWith('q:')){await answerCallback(cb.id,'Кнопка не распознана: решение не применено.',true);return true;}return false;}
  const [, action, id, token] = m;
  if (!isApprover(cb.from?.id)) {
    await answerCallback(cb.id, "Согласует ответственный со стороны компании. Если это вы, попросите оператора добавить ваш номер.", true);
    return true;
  }
  const unlock=lock(dataPath('approval-actions',`${id}.lock`),120000);
  if(!unlock){await answerCallback(cb.id,'Эта карточка уже обрабатывается. Дождитесь обновления.',true);return true;}
  try{
  const entry = get(id);
  if (!entry) { await answerCallback(cb.id, "Этой записи уже нет в очереди.", true); return true; }
  const name = who(cb.from);
  const actor = `tg:${cb.from.id}`;

  /* «Да» относится к тексту, который человек видит над кнопкой. Запись могли поправить и
     отправить заново: в теме тогда две карточки, и под первой висит прежний текст. Нажатие
     «Одобрить» под ней одобрило бы текст, которого утверждающий не читал. Поэтому решение
     о тексте принимается только под текущей карточкой записи. Отзыв и снятие тоже
     привязаны к версии и сообщению; у тревоги отдельная подтверждённая привязка. */
  const pressed = Number(cb.message?.message_id) || 0;
  const card = Number(entry.approval?.card?.messageId) || 0;
  const ownGroup=String(cb.message?.chat?.id)===String(groupId());
  const bound=pressed&&pressed===card&&(!entry.approval?.cardHash||entry.approval.cardHash===entry.contentHash)&&
    (entry.approval?.actionToken?token===entry.approval.actionToken:!token);
  const recovery=entry.recoveryCard;
  const alarm=['no','next'].includes(action)&&['failed','expired'].includes(entry.status)&&pressed&&pressed===Number(recovery?.messageId)&&token===recovery?.token&&recovery?.hash===entry.contentHash;
  const ambiguous=pressed&&all().some(e=>e.id!==id&&e.approval?.card?.messageId===pressed);
  if (!ownGroup||ambiguous||(!bound&&!alarm)) {
    await answerCallback(cb.id, "Эта карточка устарела или не относится к выбранной записи. Решение не применено; используйте текущую карточку в рабочей группе.", true);
    return true;
  }
  const expected={contentHash:entry.contentHash,...(entry.approval?.actionToken?{actionToken:entry.approval.actionToken}:{}),...(bound?{card:entry.approval.card.messageId}:{})};
  // Просроченный или не подтверждённый Telegram callback не становится решением.
  const acknowledged=await answerCallback(cb.id);
  if(acknowledged.kind!=='ok')return true;

  try {
    if (action === "ok") {
      if (entry.status !== "review") { await answerCallback(cb.id, `Запись сейчас «${STATUS_TITLE[entry.status]}».`, true); return true; }
      const verdict = check(entry);
      if (verdict.block.length) { await answerCallback(cb.id, `Проверка не пускает: ${verdict.block[0].slice(0, 150)}`, true); return true; }
      const approved = await approveEntry(entry.id,{...(entry.approval||{}),actionToken:newToken(),by:cb.from.id,name,at:new Date().toISOString()},actor,expected);
      const moved=entry.date!==approved.date||entry.time!==approved.time?' Срок пересчитан после одобрения.':'';
      await answerCallback(cb.id, "Одобрено.");
      // Ролик, загруженный до «да», лежит на YouTube без срока: срок ставится сейчас.
      const yt = await syncYoutube(entry.id);
      const tail = yt ? `\n${h(yt)}` : "";
      // Ролик YouTube открывает сам YouTube по сроку, который ставит сервер: перехват его не задерживает.
      const wait = entry.channel === "youtube" ? "" : waitNote();
      const said = wait
        ? `✅ Одобрил(а) ${h(name)}.${wait}`
        : entry.kind === "reply" ? `✅ Одобрил(а) ${h(name)}. Текст ответа придёт в тему «Выложить руками» в течение пяти минут.` : `✅ Одобрил(а) ${h(name)}. Выйдет ${human(approved)}.${moved}`;
      await redraw(approved, `${said}${entry.kind === "reply" ? "" : tail}`, UNDO(approved));
    } else if (action === "fix") {
      if (!["review", "approved"].includes(entry.status)) { await answerCallback(cb.id, `Запись сейчас «${STATUS_TITLE[entry.status]}».`, true); return true; }
      let current=await patch(entry.id, { fixAsked: { by: cb.from.id, name, at: new Date().toISOString() } }, actor,expected);
      await answerCallback(cb.id, "Режим правки включён.");
      const guidance="✏️ <b>Режим правки включён.</b>\nТеперь напишите свои замечания в поле ответа на запрос бота ниже. Весь текст поста копировать не нужно.";
      const prompt=await sendMessage(groupId(),`<a href="tg://user?id=${cb.from.id}">${h(name)}</a>, теперь напишите, что изменить в этой публикации. Можно указать только замечание или точную замену фразы.`,{
        ...(cb.message?.message_thread_id?{message_thread_id:cb.message.message_thread_id}:{}),
        reply_parameters:{message_id:entry.approval.card.messageId},
        reply_markup:{force_reply:true,selective:true,input_field_placeholder:"Напишите, что изменить"},
      });
      const promptId=prompt.data?.result?.message_id;
      if(prompt.kind!=="ok"||!promptId)throw Object.assign(new Error('запрос замечания не отправлен; можно ответить на исходную карточку'),{code:'ENV'});
      current=await patch(entry.id,{fixAsked:{...current.fixAsked,promptId}},actor,expected);
      await redraw(current,guidance,current.status==='approved'?UNDO(current):BUTTONS(current));
    } else if (action === "no") {
      if (["published", "cancelled", "running"].includes(entry.status)) { await answerCallback(cb.id, `Запись уже «${STATUS_TITLE[entry.status]}».`, true); return true; }
      const cancelled = await transition(entry.id, "cancelled", { note: `снял(а) ${name}` }, actor,expected);
      await answerCallback(cb.id, "Снято.");
      // «Не выйдет» про ролик с датой выхода говорится только по ответу YouTube.
      const yt = await syncYoutube(entry.id);
      // Пакет уже у сотрудника: программа выложенное не снимет, об этом и говорим.
      // При перехвате «Не выйдет» не говорится: о снятии компьютер оператора узнаёт не сразу.
      const lag = lagNote(entry.status === "approved");
      const said = entry.status === "handed" ? "Пакет в теме «Выложить руками» больше не действует. Если материал уже выложен, его убирает владелец аккаунта." : yt ? h(yt) : lag ? "" : "Не выйдет.";
      await redraw(cancelled, `🚫 Снял(а) ${h(name)}.${said ? ` ${said}` : ""}${lag}`, null);
    } else if (action === "undo") {
      if (entry.status !== "approved") { await answerCallback(cb.id, `Отозвать уже нельзя: запись «${STATUS_TITLE[entry.status]}».`, true); return true; }
      const back = await transition(entry.id, "review", { approval: {...entry.approval,by:undefined,name:undefined,at:undefined,actionToken:newToken()}, note: `согласие отозвал(а) ${name}` }, actor,expected);
      await answerCallback(cb.id, "Согласие отозвано.");
      const yt = await syncYoutube(entry.id);
      const tail = yt ? `\n${h(yt)}` : "";
      await redraw(back, `↩️ Согласие отозвал(а) ${h(name)}. Запись снова ждёт решения.${lagNote(true)}${tail}`, BUTTONS(back));
    } else if (action === "next") {
      if (!["expired", "failed"].includes(entry.status)) { await answerCallback(cb.id, `Запись сейчас «${STATUS_TITLE[entry.status]}».`, true); return true; }
      const slot = slotFor(entry, all(), channelCfg(entry.channel));
      if (!slot) { await answerCallback(cb.id, "Свободных слотов на два месяца вперёд нет.", true); return true; }
      const moved = await reschedule(entry.id, slot.date, slot.time, actor,expected);
      const current=await patch(entry.id,{approval:{...moved.approval,actionToken:newToken()},recoveryCard:undefined},actor,expected);
      await redraw(current,`Слот перенесён на ${human(current)}.`,UNDO(current));
      await answerCallback(cb.id, `Поставил на ${human(moved)}.`, true);
      await syncYoutube(entry.id);
    }
  } catch (e) {
    await answerCallback(cb.id, e.code === "RULE" ? e.message.slice(0, 180) : "Не получилось, оператор уже видит ошибку.", true);
    if (e.code !== "RULE") console.error("[approval] сбой обработки кнопки", e);
  }
  return true;
  }finally{unlock();}
}

/**
 * Ответ на карточку текстом: правка от утверждающего. Возвращает true, если это она.
 * @param {{ text?: string, from: object, reply_to_message?: { message_id: number } }} message
 */
export async function handleReply(message) {
  const replied = message.reply_to_message?.message_id;
  if (!replied || !message.text) return false;
  if(String(message.chat?.id)!==String(groupId()))return false;
  if(!isApprover(message.from?.id))return false;
  const tell=text=>sendMessage(groupId(),text,{...(message.message_thread_id?{message_thread_id:message.message_thread_id}:{}),...(message.message_id?{reply_parameters:{message_id:message.message_id}}:{})});
  if(/^\s*(?:одобрить|одобряю|одобрено|согласовать|согласовано|да)\s*[.!]?\s*$/iu.test(message.text)){
    await tell('Текстом согласие не записывается. Нажмите кнопку «Одобрить» под текущей карточкой нужной записи. Старый ответ и другие материалы не меняются.');return true;
  }
  const matches=all().filter(e=>e.approval?.card?.messageId===replied||e.fixAsked?.promptId===replied);
  if(matches.length>1){await tell('Карточка неоднозначна: правка не применена. Оператор проверит привязку записей.');return true;}
  const entry = matches[0];
  if (!entry) return false;
  if (!isApprover(message.from?.id)) return true; // обсуждение под карточкой правкой не считаем
  if (!["review", "approved"].includes(entry.status)) return true;
  if(!entry.fixAsked){await tell('Нажмите «Исправить» под текущей карточкой и напишите замечание в поле ответа. Статус записи не изменён.');return true;}
  const unlock=lock(dataPath('approval-actions',`${entry.id}.lock`),120000);if(!unlock){await tell('Эта карточка уже обрабатывается. Дождитесь обновления.');return true;}
  try{
  const name = who(message.from);
  const actor = `tg:${message.from.id}`;
  let current = entry;
  const expected={contentHash:entry.contentHash,card:entry.approval.card.messageId,...(entry.approval.actionToken?{actionToken:entry.approval.actionToken}:{})};
  if (entry.status === "approved") current = await transition(entry.id, "review", { approval: {...entry.approval,by:undefined,name:undefined,at:undefined} }, actor,expected);
  const rework = await transition(current.id, "rework", { note: message.text.slice(0, 1500), fixAsked: undefined, reworkBy: name }, actor,expected);
  const yt = await syncYoutube(entry.id);
  const tail = yt ? `\n${h(yt)}` : "";
  await redraw(rework, `✏️ На правке. ${h(name)}: «${h(message.text.slice(0, 300))}»\nВернётся новой карточкой.${lagNote(entry.status === "approved")}${tail}`, null);
  return true;
  }catch(e){if(e.code!=='RULE')throw e;await tell('Карточка изменилась: правка не применена. Используйте текущую карточку.');return true;}finally{unlock();}
}

/** Что ждёт оператора: записи на правке с текстом замечания. */
export function inbox() {
  return all().filter((e) => e.status === "rework").map((e) => ({ id: e.id, channel: e.channel, name: e.name, note: e.note || "", by: e.reworkBy || "", preview: preview(e) }));
}
