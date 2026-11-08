import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {intakePreview} from '../src/media/intake-preview.mjs';
test('закрытый preview сверяет SHA/размер/выбор и повторно проверяет job до выдачи пути',async()=>{
 const folder=mkdtempSync(path.join(tmpdir(),'intake-preview-')),bytes=Buffer.from('synthetic closed file'),mediaId='med_'+'b'.repeat(32),asset={mediaId,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,mime:'image/jpeg'},job={id:'a'.repeat(16),revision:1,protocolVersion:2,inputHash:'c'.repeat(64),input:{files:[asset],targetMedia:{'telegram:album':[mediaId]}}};
 const options={folder,refresh:async()=>({job}),transfer:async(a,file)=>writeFileSync(file,bytes)};
 const preview=await intakePreview('claim',mediaId,options);assert.equal(preview.visibility,'private-local');assert.equal(existsSync(preview.file),true);assert.equal(preview.sha256,asset.sha256);
 await assert.rejects(()=>intakePreview('claim',mediaId,{...options,transfer:async(a,file)=>writeFileSync(file,'wrong')}),/hash/);
 await assert.rejects(()=>intakePreview('claim',mediaId,{...options,refresh:async()=>({job:{...job,input:{...job.input,targetMedia:{}}}})}),/selected/);
 let reads=0;await assert.rejects(()=>intakePreview('claim',mediaId,{...options,refresh:async()=>({job:{...job,inputHash:++reads===1?job.inputHash:'d'.repeat(64)}})}),/changed/);
});
