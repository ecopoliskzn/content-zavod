// Подмена сети для запуска настоящего src/video/youtube-cli.mjs в тесте: вместо Google и
// сервера завода заглушки. Подключается флагом --import. Состояние (сколько роликов
// загружено, какой срок стоит на ролике, запись очереди) лежит в файле YT_STUB_STATE и
// переживает два запуска команды подряд.
import { readFileSync, writeFileSync } from "node:fs";

const file = process.env.YT_STUB_STATE;
const load = () => JSON.parse(readFileSync(file, "utf8"));
const save = (s) => writeFileSync(file, JSON.stringify(s));
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const VIDEO = "vvvvvvvvvvv";

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const s = load();
  if (u.startsWith("https://zavod.test/admin/queue")) {
    const p = JSON.parse(init.body);
    if (p.cmd === "show") return json({ code: 0, lines: [], data: s.entry });
    if (p.cmd === "extra") {
      // Обрыв связи: запрос ушёл либо не ушёл, ответа нет.
      if (process.env.YT_STUB_EXTRA === "fail") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      s.entry.extra = { ...(s.entry.extra || {}), ...p.args.fields };
      save(s);
      return json({ code: 0, lines: ["дописано (youtubeId, youtubePublishAt, youtubeHash)"], data: s.entry });
    }
    return json({ code: 1, lines: [`заглушка не знает команды ${p.cmd}`] });
  }
  if (u.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "t", expires_in: 3600 });
  if (u.includes("/upload/youtube/v3/videos")) {
    // Открытие загрузки: срок выхода приходит здесь.
    s.publishAt = JSON.parse(init.body).status.publishAt || "";
    save(s);
    return new Response("", { status: 200, headers: { location: "https://upload.test/session" } });
  }
  if (u.startsWith("https://upload.test/session")) {
    s.uploads += 1;
    save(s);
    return json({ id: VIDEO, status: { privacyStatus: "private" } });
  }
  if (u.includes("/youtube/v3/videos?part=status") && (init.method || "GET") === "PUT") {
    // Правка замещает блок status целиком: нет поля publishAt, значит, срок снят.
    s.publishAt = JSON.parse(init.body).status.publishAt || "";
    save(s);
    return json({ id: VIDEO });
  }
  if (u.includes("/youtube/v3/videos?part=status,snippet")) {
    return json({ items: [{ id: VIDEO, status: { privacyStatus: "private", uploadStatus: "processed", ...(s.publishAt ? { publishAt: s.publishAt } : {}) }, snippet: { title: s.entry.title } }] });
  }
  return json({ items: [] });
};
