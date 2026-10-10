#!/usr/bin/env node
/**
 * 麦门日历 · 订阅服务（本地 HTTP）
 *
 * 提供长期可订阅的日历链接，苹果日历 / 谷歌日历 / Outlook 添加后自动刷新。
 *
 * 启动：
 *   MCD_MCP_TOKEN=xxx node serve.mjs --city 上海 --budget 40 --training fatLoss --port 8899
 *
 * 然后把下面任一链接添加到日历应用：
 *   苹果日历：   webcal://127.0.0.1:8899/maimen.ics
 *   谷歌日历：   http://127.0.0.1:8899/maimen.ics  （需公网地址）
 *   Outlook：   http://127.0.0.1:8899/maimen.ics
 *
 * 说明：苹果日历支持 webcal://，会按 REFRESH-INTERVAL 自动拉取更新。
 *       若要从外网订阅，需将本服务部署到公网（或内网穿透）。
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) {
        out[k] = v;
        i++;
      } else out[k] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PORT = args.port ? Number(args.port) : 8899;
const HOST = args.host || "127.0.0.1";
const REFRESH_MINUTES = args.refresh ? Number(args.refresh) : 360; // 默认 6 小时

/** 缓存：避免每次订阅拉取都打 MCP（限流 600/分钟，但没必要）。 */
let cache = { ics: null, at: 0, building: null };
const CACHE_TTL = REFRESH_MINUTES * 60 * 1000;

function generateIcs() {
  return new Promise((resolve, reject) => {
    const cliArgs = [join(__dirname, "cli.mjs"), "--json"];
    if (args.city) cliArgs.push("--city", args.city);
    if (args.budget) cliArgs.push("--budget", args.budget);
    if (args.days) cliArgs.push("--days", args.days);
    if (args.training) cliArgs.push("--training", args.training);
    if (args.weight) cliArgs.push("--weight", args.weight);
    if (args.goal) cliArgs.push("--goal", args.goal);
    if (args.remind) cliArgs.push("--remind", args.remind);
    if (args.demo) cliArgs.push("--demo");

    execFile(process.execPath, cliArgs, { maxBuffer: 8 * 1024 * 1024, env: process.env }, async (err, stdout) => {
      if (err) return reject(err);
      try {
        const data = JSON.parse(stdout);
        const { scheduleToIcs } = await import("./ics.mjs");
        const ics = scheduleToIcs(data.schedule || [], { calendarName: "麦门日历 · 麦门午饭与训练" });
        resolve(ics);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function getIcs() {
  const now = Date.now();
  if (cache.ics && now - cache.at < CACHE_TTL) return cache.ics;
  if (cache.building) return cache.building;
  cache.building = generateIcs()
    .then((ics) => {
      cache = { ics, at: Date.now(), building: null };
      return ics;
    })
    .catch((e) => {
      cache.building = null;
      throw e;
    });
  return cache.building;
}

/** 给 .ics 补上订阅刷新提示（苹果日历会读这个）。 */
function withRefreshHints(ics) {
  const lines = ics.split("\r\n");
  const out = [];
  for (const l of lines) {
    out.push(l);
    if (l.startsWith("X-WR-CALNAME")) {
      out.push(`REFRESH-INTERVAL;VALUE=DURATION:PT${REFRESH_MINUTES}M`);
      out.push(`X-PUBLISHED-TTL:PT${REFRESH_MINUTES}M`);
    }
  }
  return out.join("\r\n");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, cached: Boolean(cache.ics), age: Date.now() - cache.at }));
    return;
  }

  if (url.pathname === "/maimen.ics" || url.pathname === "/calendar.ics") {
    try {
      const ics = withRefreshHints(await getIcs());
      res.writeHead(200, {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="maimen.ics"',
        "Cache-Control": `public, max-age=${REFRESH_MINUTES * 60}`,
      });
      res.end(ics);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("生成日历失败：" + e.message);
    }
    return;
  }

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>麦门日历 · 订阅</title>
<style>body{font-family:-apple-system,"Segoe UI",sans-serif;max-width:640px;margin:40px auto;padding:0 20px;line-height:1.7;color:#222}
code{background:#f4f4f5;padding:2px 6px;border-radius:4px;font-size:13px}
a{color:#c8102e}.tip{background:#fffbeb;border-left:3px solid #f59e0b;padding:12px 16px;border-radius:4px;margin:16px 0}
</style></head><body>
<h1>🍟 麦门日历 · 订阅</h1>
<p>把下面的链接添加到你的日历应用，即可自动同步「吃饭提醒 + 训练计划 + 活动日」。</p>
<ul>
  <li><b>苹果日历</b>：<code>webcal://${HOST}:${PORT}/maimen.ics</code></li>
  <li><b>谷歌日历</b>：<code>http://${HOST}:${PORT}/maimen.ics</code></li>
  <li><b>Outlook</b>：<code>http://${HOST}:${PORT}/maimen.ics</code></li>
</ul>
<p>刷新间隔：每 ${REFRESH_MINUTES} 分钟。</p>
<div class="tip">谷歌日历从服务器拉取订阅，<b>需要公网可访问的地址</b>；本机 127.0.0.1 仅苹果日历/Outlook 可用。如需外网订阅，请部署到公网或做内网穿透。</div>
<p><a href="/maimen.ics">下载 .ics 文件（手动导入）</a> · <a href="/health">健康检查</a></p>
<p style="color:#888;font-size:13px">非官方应用 · 只提醒不下单 · 力度评分为估算</p>
</body></html>`);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found. 试试 /maimen.ics 或 /");
});

server.listen(PORT, HOST, () => {
  console.log(`🍟 麦门日历订阅服务已启动`);
  console.log(`   本地页面：http://${HOST}:${PORT}/`);
  console.log(`   订阅地址：http://${HOST}:${PORT}/maimen.ics`);
  console.log(`   苹果日历：webcal://${HOST}:${PORT}/maimen.ics`);
  console.log(`   刷新间隔：${REFRESH_MINUTES} 分钟`);
});
