// Keep this allowlist in sync with config/exchanges.json.
const ALLOWED_HOSTS = new Set([
  "fapi.binance.com",
  "www.okx.com",
  "api.bybit.com",
  "api.bytick.com",
  "api.bybit.eu",
  "api.byhkbit.com",
  "api.bybit-tr.com",
  "api.bybit.kz",
  "indexer.dydx.trade",
  "api.hyperliquid.xyz",
  "api.bitget.com",
  // 新增:Gate.io / MEXC(永续+现货)
  "api.gateio.ws",
  "contract.mexc.com",
  "api.mexc.com",
  // 新增:Meme 异动数据源(链上 DEX + 合约安全检测)
  "api.dexscreener.com",
  "api.geckoterminal.com",
  "api.gopluslabs.io",
  // 新增:期权 Wall 数据源(Deribit 公开期权数据)
  "www.deribit.com",
]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function isAllowedTarget(url) {
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    (!url.port || url.port === "443") &&
    ALLOWED_HOSTS.has(url.hostname)
  );
}

async function fetchAllowedTarget(initialUrl, request) {
  let target = initialUrl;
  let method = request.method;
  let body = method === "POST" ? await request.arrayBuffer() : undefined;
  const headers = new Headers({ Accept: "application/json" });
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);

  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(target.toString(), {
      method,
      headers,
      body,
      redirect: "manual",
    });

    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get("location");
    if (!location) return response;

    const nextTarget = new URL(location, target);
    if (!isAllowedTarget(nextTarget)) {
      throw new Error("Upstream redirected to a host that is not allowed");
    }

    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers.delete("Content-Type");
    }
    target = nextTarget;
  }

  throw new Error("Too many upstream redirects");
}

export async function onRequest({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const requestUrl = new URL(request.url);
  const rawTarget = requestUrl.searchParams.get("url");
  if (!rawTarget) return jsonResponse(400, { error: "Missing url parameter" });

  let target;
  try {
    target = new URL(rawTarget);
  } catch {
    return jsonResponse(400, { error: "Invalid target URL" });
  }

  if (!isAllowedTarget(target)) {
    return jsonResponse(403, { error: "Target host is not allowed" });
  }

  try {
    const upstream = await fetchAllowedTarget(target, request);
    const headers = new Headers(CORS_HEADERS);
    headers.set("Content-Type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    return jsonResponse(502, {
      error: String(error && error.message ? error.message : error),
      target: target.hostname,
    });
  }
}
