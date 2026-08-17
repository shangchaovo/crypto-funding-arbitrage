const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const PORT = Number(process.env.PORT || 8765);
const ROOT = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "exchanges.json"), "utf8"));
const ALLOWED_HOSTS = new Set(CONFIG.exchanges.flatMap((exchange) => exchange.hosts)); // 优化: proxy allowlist 集中到配置文件
// 优化: launchd 服务 env 同时含 all_proxy/ALL_PROXY 与 https_proxy，而 curl 的 ALL_PROXY 优先级高于 HTTPS_PROXY，
// 二者在本机代理(Surge/Clash)里可能命中不同规则/出口——实测 ALL_PROXY 路径被 OKX 返 400，HTTPS_PROXY 路径 200。
// 故显式用 --proxy 指定(取 https_proxy 值)覆盖继承的 ALL_PROXY，使 server 与交互 shell 走同一代理机制；
// 设 PROXY_URL=none / HTTP_PROXY=none 可关闭。--noproxy 白名单保证 localhost 的 data/rates.json 直连不被代理。
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "http://127.0.0.1:1082";
const USE_PROXY = Boolean(PROXY_URL) && PROXY_URL !== "none";
const NOPROXY_LIST = "localhost,127.0.0.1,::1";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store", // 优化: 本地调试时避免旧 JS/CSS 缓存导致界面不更新
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), { "Content-Type": "application/json; charset=utf-8" });
}

function safeStaticPath(urlPath) {
  // 优化: decodeURIComponent 遇非法 % 序列会抛 URIError，请求处理器无外层 try/catch，未捕获会杀掉整个进程
  try {
    const decoded = decodeURIComponent(urlPath.split("?")[0]);
    const requested = decoded === "/" ? "/index.html" : decoded;
    const resolved = path.resolve(ROOT, `.${requested}`);
    if (!resolved.startsWith(ROOT)) return null;
    return resolved;
  } catch (error) {
    return null;
  }
}

async function proxyRequest(req, res, requestUrl) {
  const target = requestUrl.searchParams.get("url");
  if (!target) {
    sendJson(res, 400, { error: "Missing url parameter" });
    return;
  }
  // 优化: direct=1 表示“跳过代理直连”——前端在代理路径失败(如 OKX 对代理出口 400)时回退调用
  const forceDirect = requestUrl.searchParams.get("direct") === "1";

  let parsed;
  try {
    parsed = new URL(target);
  } catch (error) {
    sendJson(res, 400, { error: "Invalid target URL" });
    return;
  }

  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    sendJson(res, 403, { error: "Target host is not allowed" });
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    // 优化: 直连兜底用更短 connect 超时——本机系统 DNS 被代理劫持时直连会“Resolving timed out”，4s 足够真实直连，减少代理失败时的白等
    const args = ["-L", "--fail-with-body", "--max-time", "20", "--connect-timeout", forceDirect ? "4" : "8", "-sS"];
    if (forceDirect) {
      args.push("--noproxy", "*"); // 优化: 直连兜底——屏蔽所有继承代理，用服务器本机出口
    } else if (USE_PROXY) {
      args.push("--proxy", PROXY_URL, "--noproxy", NOPROXY_LIST); // 优化: 显式 --proxy 覆盖继承的 ALL_PROXY(其出口被 OKX 拦)；--noproxy 让 localhost 预取文件直连
    } else {
      args.push("--noproxy", "*");
    }
    if (req.method === "POST") args.push("-X", "POST");
    if (req.headers["content-type"]) args.push("-H", `Content-Type: ${req.headers["content-type"]}`);
    if (req.method === "POST") args.push("--data", Buffer.concat(chunks).toString("utf8"));
    args.push(target);

    execFile("curl", args, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        sendJson(res, 502, { error: stderr || stdout || String(error.message || error), target: parsed.hostname });
        return;
      }
      send(res, 200, stdout, { "Content-Type": "application/json; charset=utf-8" });
    }); // 优化: 本地 proxy 使用 curl，绕开当前环境 Node fetch 外网 HTTPS 失败问题
  });
}

function serveStatic(res, filePath) {
  if (!filePath) {
    send(res, 403, "Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }
    const type = MIME_TYPES[path.extname(filePath)] || "application/octet-stream";
    send(res, 200, data, { "Content-Type": type });
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return;
  }

  let requestUrl;
  try {
    requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch (error) {
    sendJson(res, 400, { error: "Invalid request URL" }); // 优化: 畸形请求行不再抛出未捕获异常
    return;
  }
  if (requestUrl.pathname === "/proxy") {
    proxyRequest(req, res, requestUrl);
    return;
  }

  serveStatic(res, safeStaticPath(requestUrl.pathname));
});

server.listen(PORT, () => {
  console.log(`Funding dashboard running at http://localhost:${PORT}`);
});
