// Измерение геометрии и кодека отдельно от CLI: используется старым загрузчиком
// и закрытой медиатекой без циклического запуска команды импорта.
import {spawnSync} from 'node:child_process';
export function probeVideo(file,{execute=spawnSync}={}) {
 const r=execute('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-select_streams','v:0','-show_entries','stream=width,height,codec_name,pix_fmt,color_transfer:stream_side_data=rotation:format=duration','-of','json',file],{encoding:'utf8',timeout:10000,maxBuffer:65536,windowsHide:true});
 if(r.error||r.status!==0)return null;
 try{const data=JSON.parse(r.stdout),s=data.streams?.[0]||{},rotation=Math.abs(Number(s.side_data_list?.find(d=>d.rotation!==undefined)?.rotation||0));const [width,height]=rotation===90||rotation===270?[s.height,s.width]:[s.width,s.height];return {width,height,codec:s.codec_name||'',seconds:Number(data.format?.duration)||0,hdr:/smpte2084|arib-std-b67/.test(s.color_transfer||'')};}catch{return null;}
}
