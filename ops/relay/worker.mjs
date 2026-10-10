// Обвязка релея для Cloudflare Workers. Выкладка: npx wrangler deploy (из каталога ops/relay).
// Секреты кладутся командой npx wrangler secret put <ИМЯ>, в файл они не пишутся.
import { handle } from "./relay.mjs";

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};
