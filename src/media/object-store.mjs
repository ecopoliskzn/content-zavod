// Закрытые объекты медиатеки используют тот же AWS SigV4, что существующий S3-клиент.
// Подписанная ссылка — временный доступ: только в памяти адаптера, никогда в журнале.
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {createReadStream,createWriteStream,renameSync,unlinkSync,existsSync} from 'node:fs';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {signV4,rfc3986,encodeKey} from '../lib/s3.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const hmac=(k,x)=>createHmac('sha256',k).update(x).digest();
export function presignGet({endpoint,bucket,key,accessKey,secretKey,region,expires=604800,now=new Date()}) {
 if(!Number.isInteger(expires)||expires<60||expires>604800) throw Error('недопустимый срок ссылки');
 const url=new URL(`${endpoint.replace(/\/+$/,'')}/${bucket}/${encodeKey(key)}`);
 const at=now.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');const day=at.slice(0,8),scope=`${day}/${region}/s3/aws4_request`;
 const params={'X-Amz-Algorithm':'AWS4-HMAC-SHA256','X-Amz-Credential':`${accessKey}/${scope}`,'X-Amz-Date':at,'X-Amz-Expires':String(expires),'X-Amz-SignedHeaders':'host'};
 const query=Object.keys(params).sort().map(k=>`${rfc3986(k)}=${rfc3986(params[k])}`).join('&');
 const canonical=['GET',url.pathname,query,`host:${url.host}\n`,'host','UNSIGNED-PAYLOAD'].join('\n');
 const signing=hmac(hmac(hmac(hmac(`AWS4${secretKey}`,day),region),'s3'),'aws4_request');
 const signature=createHmac('sha256',signing).update(['AWS4-HMAC-SHA256',at,scope,hash(canonical)].join('\n')).digest('hex');
 return `${url.href}?${query}&X-Amz-Signature=${signature}`;
}
function signed(config,key,method,sha='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') {
 const url=`${config.endpoint.replace(/\/+$/,'')}/${config.bucket}/${encodeKey(key)}`;
 const headers=signV4({...config,url,method,payloadHash:sha});delete headers.host;return {url,headers};
}
export async function uploadPrivate(config,row,file) {
 const {url,headers}=signed(config,row.objectKey,'PUT',row.sha256);headers['content-length']=String(row.bytes);headers['content-type']=row.mime;
 const stream=createReadStream(file);
 try{const r=await fetch(url,{method:'PUT',headers,body:stream,duplex:'half',signal:AbortSignal.timeout(1200000)});if(!r.ok)throw Error();}
 catch{throw Error('S3 не принял файл; проверьте доступ и квоту, исходник сохранён');}finally{stream.destroy();}
}
export async function downloadVerified(config,row,file) {
 if(existsSync(file))throw Error('восстановление поверх существующего файла запрещено');
 const temp=file+'.restore-part-'+randomUUID();const {url,headers}=signed(config,row.objectKey,'GET');
 try {
  const r=await fetch(url,{headers,signal:AbortSignal.timeout(1200000)});if(!r.ok||!r.body)throw Error();
  const sha=createHash('sha256');let bytes=0;
  const verify=new Transform({transform(chunk,enc,cb){sha.update(chunk);bytes+=chunk.length;if(bytes>row.bytes)cb(Error('size'));else cb(null,chunk);}});
  await pipeline(Readable.fromWeb(r.body),verify,createWriteStream(temp,{flags:'wx',mode:0o600}));
  if(bytes!==row.bytes||sha.digest('hex')!==row.sha256)throw Error();renameSync(temp,file);
 }catch{if(existsSync(temp))unlinkSync(temp);throw Error('восстановление не прошло проверку SHA256; действующие данные не заменены');}
}
