import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
process.env.DATA_DIR=mkdtempSync(path.join(tmpdir(),'operator-approval-'));process.env.ZAVOD_ENV_FILE=path.join(process.env.DATA_DIR,'absent.env');process.env.VK_GROUP_ID='1';process.env.VK_GROUP_TOKEN='synthetic';
const store=await import('../src/queue/store.mjs');const {execute}=await import('../src/queue/commands.mjs');
const raw=name=>({channel:'vk',kind:'post',name,material:'case:salavat-kupere-2026-10',date:'2030-06-01',time:'12:00',text:`«${name}»: примыкания покрытия проверяют после укладки.`});
const args=e=>({ref:e.id,'content-hash':e.contentHash,basis:'Оператор 06.11.2026 письменно подтвердил прежнее согласие для текущего кейса.','confirm-prior-approval':true});
test('узкое решение по конкретному хешу одобряет одну запись без карточки',async()=>{
 const a=(await store.put(raw('one'))).entry,b=(await store.put(raw('two'))).entry;
 const r=await execute('record-approval',args(a),'оператор');assert.equal(r.code,0);assert.equal(store.get(a.id).status,'approved');assert.equal(store.get(b.id).status,'draft');
 assert.equal(store.get(a.id).approval.kind,'operator-exception');assert.equal(store.get(a.id).approval.contentHash,a.contentHash);assert.equal(store.get(a.id).approval.card,undefined);assert.equal(store.get(a.id).approval.by,undefined);
 assert.equal((await execute('record-approval',args(a),'оператор')).code,1);
});
test('проверка, старый хеш, отсутствие подтверждения и другой материал дают отказ',async()=>{
 for(const [name,change,flags] of [['blocked',{text:'Покрытие служит [здесь срок] лет.'},{}],['hash',{}, {'content-hash':'f'.repeat(16)}],['confirm',{}, {'confirm-prior-approval':false}],['scope',{material:'blog:other'},{}]]){
  const e=(await store.put({...raw(name),...change})).entry;const r=await execute('record-approval',{...args(e),...flags},'оператор');assert.equal(r.code,1,name);assert.equal(store.get(e.id).status,'draft',name);
 }
});
