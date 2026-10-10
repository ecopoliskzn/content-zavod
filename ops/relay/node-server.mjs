#!/usr/bin/env node
// Обвязка релея для обычного Node (20+): запасной вариант, если Cloudflare из России
// работает нестабильно. Ставится на самый маленький сервер за границей (у Timeweb это
// Нидерланды), за Caddy или nginx с HTTPS: Telegram шлёт обновления только на https.
//
//   RELAY_PORT=8787 node node-server.mjs
// Переменные те же, что у релея, берутся из окружения процесса (файл для systemd:
// /etc/zavod-relay.env, права 600).

import { createServer } from "node:http";
import { Readable } from "node:stream";
import { handle } from "./relay.mjs";

const port = Number(process.env.RELAY_PORT) || 8787;

createServer(async (req, res) => {
  try {
    const hasBody = !["GET", "HEAD"].includes(req.method);
    const request = new Request(`https://relay.local${req.url}`, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string")),
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? "half" : undefined,
    });
    const out = await handle(request, process.env);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    if (out.body) Readable.fromWeb(out.body).pipe(res);
    else res.end();
  } catch (e) {
    // В журнал идёт только код и причина сбоя. Тело запроса не пишется никогда.
    console.error(`${new Date().toISOString()} сбой релея: ${e?.message || e}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  }
}).listen(port, "127.0.0.1", () => console.log(`релей слушает 127.0.0.1:${port}`));
