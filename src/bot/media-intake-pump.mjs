// Короткий кодовый проход служебного приёма. Не вызывает модель и не выпускает посты.
// Один незавершённый проход на процесс; межпроцессные замки остаются у обработчиков.
export function createIntakePump({flush,deliver,enabled=()=>true,onError=()=>{}}){
 let active=null;
 const run=()=>{
  if(active)return active;
  if(!enabled())return Promise.resolve({disabled:true});
  active=(async()=>{try{const result=await flush();if(!result?.disabled&&!result?.busy)await deliver();return result;}catch{onError('intake_pending');return{pending:true};}finally{active=null;}})();
  return active;
 };
 return{run};
}
