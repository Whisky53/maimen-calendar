/**
 * 麦当劳 MCP 传输层（maimen-meal 与 maimen-calendar 共用）。
 *
 * 协议：Streamable HTTP（JSON-RPC 2.0），接入地址 https://mcp.mcd.cn
 * 鉴权：Authorization: Bearer <MCD_MCP_TOKEN>
 * Token 只从环境变量读取，绝不写入源码 / 仓库 / 日志。
 *
 * 已实测确认的接口事实（勿凭猜测改动）：
 *   - items 的商品字段名是 productCode（不是 code），quantity 为整数
 *   - calculate-price 返回的 price / originalPrice / discount 单位是「分」
 *   - query-meals 返回 currentPrice / originalPrice 是「元」字符串
 *   - query-nearby-stores / query-meals / calculate-price 必填 storeCode + beType + orderType
 *   - 响应同时存在于 result.content[0].text 与 result.structuredContent，优先取后者
 *
 * 无 Token 时 callTool 返回 null，由上层决定降级策略（不得伪装成真实结果）。
 */

const MCP_URL = process.env.MCD_MCP_URL || "https://mcp.mcd.cn";
const TOKEN = process.env.MCD_MCP_TOKEN || "";

/** 默认到店自取场景参数（真实接口必填）。 */
export const STORE_CONTEXT = { beType: 1, orderType: 1 };

/** 是否具备真实 MCP 能力。 */
export function hasMcp() {
  return Boolean(TOKEN);
}

let reqId = 0;

/**
 * 调用一个 MCP tool，返回 structuredContent.data（无则回退解析 text）。
 * 业务失败（success:false）与传输失败都抛错，由上层区分处理。
 * @param {string} name  tool 名，如 query-meals
 * @param {object} args  参数
 * @returns {Promise<any|null>} 无 Token 时返回 null
 */
export async function callTool(name, args = {}) {
  if (!TOKEN) return null;
  reqId += 1;
  let res;
  try {
    res = await fetch(MCP_URL, {
      signal: AbortSignal.timeout(15000),
      redirect: "error",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: reqId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
  } catch (e) {
    const err = new Error(`MCP ${name} 网络不可达或请求超时`);
    err.kind = "transport";
    throw err;
  }
  if (!res.ok) {
    // 401 Token 失效 / 429 限流；错误信息中绝不回显 Token
    const err = new Error(`MCP ${name} 调用失败：HTTP ${res.status}`);
    err.kind = "transport";
    err.status = res.status;
    throw err;
  }
  return extractData(parseMcpText(await res.text()), name);
}

/** 兼容 application/json 与 text/event-stream 两种响应。 */
export function parseMcpText(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return unwrap(JSON.parse(trimmed));
  // SSE：取最后一条有效 data:
  const lines = trimmed.split(/\r?\n/).filter((l) => l.startsWith("data:"));
  for (let i = lines.length - 1; i >= 0; i--) {
    const payload = lines[i].slice(5).trim();
    if (!payload) continue;
    let parsed;
    try { parsed = JSON.parse(payload); } catch { continue; }
    if (parsed.result !== undefined || parsed.error) return unwrap(parsed);
  }
  return null;
}

function unwrap(j) {
  if (j.error) {
    const err = new Error(`MCP 错误：${j.error.message || JSON.stringify(j.error)}`);
    err.kind = "business";
    err.code = j.error.code;
    throw err;
  }
  const r = j.result;
  if (!r) return null;
  if (r.isError) {
    const err = new Error("MCP 工具执行失败");
    err.kind = "business";
    throw err;
  }
  // 真实接口优先返回 structuredContent
  if (r.structuredContent) return r.structuredContent;
  if (Array.isArray(r.content)) {
    const first = r.content.find((c) => c && c.type === "text");
    if (first && typeof first.text === "string") {
      try {
        return JSON.parse(first.text);
      } catch {
        return first.text;
      }
    }
  }
  return r;
}

/**
 * 从 structuredContent 中抽出 data，并统一校验 success 字段。
 * 业务失败（success:false）抛出带 code/message/kind=business 的错误，
 * 与传输失败（kind=transport）区分开，便于上层判定「业务无解」还是「服务失败」。
 */
function extractData(sc, name) {
  if (!sc || typeof sc !== "object") return sc;
  if (sc.success === false) {
    const err = new Error(`MCP ${name} 业务失败 ${sc.code || ""}：${sc.message || "未知错误"}`);
    err.kind = "business";
    err.code = sc.code;
    throw err;
  }
  return "data" in sc ? sc.data : sc;
}

/** 列出可用工具（联调时验证权限用）。 */
export async function listTools() {
  if (!TOKEN) return null;
  const res = await fetch(MCP_URL, {
    signal: AbortSignal.timeout(15000),
    redirect: "error",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++reqId, method: "tools/list" }),
  });
  if (!res.ok) throw new Error(`tools/list 失败：HTTP ${res.status}`);
  const j = parseMcpText(await res.text());
  return j && j.tools ? j.tools : j;
}
