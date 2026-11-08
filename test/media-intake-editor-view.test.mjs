import test from 'node:test';import assert from 'node:assert/strict';import {editorTaskView,editorSourceView} from '../src/bot/media-intake-editor-view.mjs';
const claim={schema:1,token:'NEVER_PRINT_TOKEN',owner:'S1',requestId:'a'.repeat(32),job:{id:'b'.repeat(16),materialId:'c'.repeat(16),revision:1,inputHash:'d'.repeat(64),claim:{token:'NESTED_TOKEN',author:'NEVER_PRINT_AUTHOR'},input:{goal:'show-object',brief:'Показать образец покрытия.',files:[{mediaId:'med_'+'e'.repeat(32),sha256:'f'.repeat(64),bytes:12,mime:'image/jpeg',url:'NEVER_PRINT_URL'}],targets:[{channel:'telegram',format:'album',delivery_mode:'auto'}],sources:[{id:'message-123',kind:'author_statement',locator:'https://t.me/c/1/2',text:'NEVER_PRINT_PRIVATE_MESSAGE'}],facts:[{claim:'Образец имеет пористую поверхность.',source:'интервью: NEVER_PRINT_AUTHOR'}],policyVersion:'test'}}};
test('editor view отделён от квитанции и не выводит token/автора/приватную переписку/URL оригинала',()=>{
 const view=editorTaskView(claim),text=JSON.stringify(view);assert.equal(view.jobId,claim.job.id);assert.equal(view.requestId,claim.requestId);assert.equal(view.brief,claim.job.input.brief);assert.equal(view.assets.length,1);assert.ok(!/NEVER_PRINT|NESTED_TOKEN|t\.me\/c/.test(text));
});
test('source selector выдаёт только ограниченный документ текущего job, а не переписку',()=>{
 assert.throws(()=>editorSourceView(claim,'message-123'),/private/);
 const c=structuredClone(claim);c.job.input.sources=[{id:'document',kind:'client-document',text:'Пористая поверхность.'}];
 assert.equal(editorSourceView(c,'document').text,'Пористая поверхность.');
 assert.throws(()=>editorSourceView(c,'another'),/private/);
 c.job.input.sources[0].text='Контакт secret@example.ru';assert.throws(()=>editorSourceView(c,'document'),/privacy/);
});
test('target view сохраняет выбор исходников и отдельные факты разных форматов',()=>{
 const c=structuredClone(claim),file=c.job.input.files[0];c.job.input.targets=[{channel:'instagram',format:'carousel',delivery_mode:'auto'},{channel:'instagram',format:'story',delivery_mode:'auto'}];
 c.job.input.targetMedia={'instagram:carousel':[file.mediaId],'instagram:story':[]};c.job.input.targetFacts={'instagram:carousel':[]};
 const v=editorTaskView(c);assert.deepEqual(v.targets[0].selectedOriginalIds,[file.mediaId]);assert.deepEqual(v.targets[0].facts,[]);assert.notEqual(v.targets[0].entryName,v.targets[1].entryName);
});
test('контактные данные и адрес с маркером требуют отдельного privacy review',()=>{
 for(const brief of ['Пишите name@example.ru','Телефон +7 (999) 123-45-67','https://example.ru/?access_token=private'])assert.throws(()=>editorTaskView({...claim,job:{...claim.job,input:{...claim.job.input,brief}}}),/privacy/);
});
test('view показывает v2/лимиты и проверяемую связь факта с публичным источником',()=>{
 const c=structuredClone(claim);Object.assign(c.job,{protocolVersion:2,recipient:'S1',manifestRevision:3,budget:{maxJobInput:24000,maxJobOutput:24000,maxCalls:4}});
 c.job.input.sources=[{id:'client-page',kind:'client-page',locator:'https://ecopolisrf.ru/article/',text:'Пористая поверхность. Образец имеет пористую поверхность.'}];
 c.job.input.facts=[{claim:'Образец имеет пористую поверхность.',source:'https://ecopolisrf.ru/article/'}];
 const v=editorTaskView(c);assert.equal(v.protocolVersion,2);assert.equal(v.manifestRevision,3);assert.equal(v.recipient,'S1');assert.equal(v.budget.maxCalls,4);assert.equal(v.facts[0].sourceRef,'client-page');assert.equal(v.facts[0].evidence.exactSourceMatch,true);
 c.job.input.sources[0].text='Другой текст.';assert.equal(editorTaskView(c).facts[0].evidence.exactSourceMatch,false);
});
