import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
process.env.DATA_DIR=mkdtempSync(path.join(tmpdir(),'card-view-'));process.env.ZAVOD_ENV_FILE=path.join(process.env.DATA_DIR,'absent.env');
process.env.PUBLIC_BASE_URL='https://example.org';
const {cardText}=await import('../src/bot/approval.mjs');const {describe}=await import('../src/video/describe.mjs');
const {h}=await import('../src/lib/telegram.mjs');
const entry={channel:'instagram',kind:'carousel',status:'review',name:'case',material:'case:internal',date:'2030-06-01',time:'18:30',text:'Полный текст публикации.\n\n#покрытие',media:[{type:'image',mediaId:'med_internal',url:'https://private.invalid/signed?secret=hidden'},{type:'image',mediaId:'med_second'}],facts:[{claim:'Служебная фактура',source:'internal-source'}],approval:{},contentHash:'same'};
test('карточка показывает публикацию, а служебные идентификаторы/источники/успешные проверки скрыты',()=>{
 const text=cardText(entry,{block:[],warn:['служебное предупреждение']});
 assert.match(text,/Instagram.*Карусель.*2 фото/);assert.match(text,/Сразу после одобрения/);assert.ok(text.includes(entry.text));
 for(const hidden of ['case:internal','med_internal','private.invalid','internal-source','Служебная фактура','Проверки пройдены','ограниченным доступом','служебное предупреждение'])assert.ok(!text.includes(hidden),hidden);
});
test('публичные кнопки, ссылки и нерешённый вопрос остаются видимыми',()=>{
 const text=cardText({...entry,link:'https://example.org/public',buttons:[[{text:'Публичная кнопка',url:'https://example.org/button'}]],ask:'Подтверждаете название объекта?'});
 for(const s of ['https://example.org/public','https://example.org/button','Публичная кнопка','Подтверждаете название объекта?'])assert.ok(text.includes(s),s);
});
test('ролик показывает реальное описание компоновщика, включая добавляемые ссылки и хэштеги',()=>{
 const e={...entry,channel:'rutube',kind:'short',title:'Название',goSlug:'guide',hashtags:['тест'],media:[{type:'video',mediaId:'med_video'}]};
 assert.ok(cardText(e).includes(h(describe(e))));assert.ok(!cardText(e).includes('med_video'));
});
test('состояние вышедшей/переданной записи явно отличается от согласования',()=>{
 assert.match(cardText({...entry,status:'published',result:{link:'https://example.org/post'}}),/Опубликовано/);
 assert.match(cardText({...entry,status:'published',result:{link:'https://example.org/post'}}),/https:\/\/example.org\/post/);
 assert.match(cardText({...entry,status:'handed'}),/Передано.*ожидает выкладки/);
 assert.match(cardText({...entry,status:'failed'}),/Не удалось выпустить/);
});
