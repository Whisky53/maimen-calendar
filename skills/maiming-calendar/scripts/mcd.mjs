/**
 * 麦当劳 MCP 适配层（maiming-calendar 版）。
 *
 * 复用 maiming-lunch 已实测确认的接口事实：
 *   - items 商品字段名是 productCode（不是 code）
 *   - calculate-price 返回价格为「分」；query-meals 的 currentPrice 是「元」字符串
 *   - query-meals / calculate-price 必填 storeCode + beType + orderType（到店自取 1/1）
 *   - 优先取 result.structuredContent
 *
 * 本模块比 maiming-lunch 多接：
 *   - campaign-calendar（活动日历）
 *   - query-store-coupons / available-coupons（优惠券）
 *   - list-nutrition-foods（营养热量，注意：返回的是紧凑文本表格，需专门解析）
 *
 * Token 只从环境变量 MCD_MCP_TOKEN 读取，绝不写入源码。
 */

const MCP_URL = process.env.MCD_MCP_URL || "https://mcp.mcd.cn";
const TOKEN = process.env.MCD_MCP_TOKEN || "";

export function hasMcp() {
  return Boolean(TOKEN);
}

export const STORE_CONTEXT = { beType: 1, orderType: 1 };

let reqId = 0;

export async function callTool(name, args = {}) {
  if (!TOKEN) return null;
  reqId += 1;
  const res = await fetch(MCP_URL, {
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
  if (!res.ok) throw new Error(`MCP ${name} 调用失败：HTTP ${res.status}`);
  return extractData(parseMcpText(await res.text()), name);
}

function parseMcpText(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return unwrap(JSON.parse(trimmed));
  const lines = trimmed.split(/\r?\n/).filter((l) => l.startsWith("data:"));
  for (let i = lines.length - 1; i >= 0; i--) {
    const payload = lines[i].slice(5).trim();
    if (!payload) continue;
    try {
      return unwrap(JSON.parse(payload));
    } catch {
      /* 继续 */
    }
  }
  return null;
}

function unwrap(j) {
  if (j.error) throw new Error(`MCP 错误：${j.error.message || JSON.stringify(j.error)}`);
  const r = j.result;
  if (!r) return null;
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

function extractData(sc, name) {
  if (!sc || typeof sc !== "object") return sc;
  if (sc.success === false) {
    throw new Error(`MCP ${name} 业务失败 ${sc.code || ""}：${sc.message || "未知错误"}`);
  }
  return "data" in sc ? sc.data : sc;
}

// ---- 业务封装 ----

export const mcd = {
  nearbyStores: (p) => callTool("query-nearby-stores", { beType: 1, searchType: 1, ...p }),
  meals: (p) => callTool("query-meals", { ...STORE_CONTEXT, ...p }),
  calculatePrice: (p) => callTool("calculate-price", { ...STORE_CONTEXT, ...p }),
  storeCoupons: (p) => callTool("query-store-coupons", { ...STORE_CONTEXT, ...p }),
  myCoupons: (p) => callTool("query-my-coupons", { ...p }),
  availableCoupons: () => callTool("available-coupons", {}),
  nutrition: () => callTool("list-nutrition-foods", {}),
  campaignCalendar: (p) => callTool("campaign-calendar", { ...p }),
  now: () => callTool("now-time-info", {}),
};

// ---- 活动日历 ----

/** 取当月活动日历（data：{currentTime, dailyList[], subscribedEvents}）。 */
export async function fetchCalendar() {
  return mcd.campaignCalendar({});
}

// ---- 营养热量解析 ----

/**
 * 解析 list-nutrition-foods 的返回。
 * ⚠️ 实测返回**不是标准 JSON**，而是形如：
 *   "…：\n  猪柳麦满分,null,1288,308,16,16,24,781,213\n  …"
 * 字段顺序：productName, nutritionDescription, energyKj, energyKcal,
 *           protein, fat, carbohydrate, sodium, calcium
 * @returns {Array<{name,kcal,kj,protein,fat,carb,sodium,calcium}>}
 */
export function parseNutrition(raw) {
  if (!raw) return [];
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  const out = [];
  // 先尝试标准 JSON 数组
  if (Array.isArray(raw)) {
    return raw.map(normalizeNutrition).filter(Boolean);
  }
  for (const line of text.split(/\r?\n/)) {
    const row = line.trim();
    if (!row || /^\[?\d+\]?\{/.test(row) || row.includes("productName")) continue;
    const cols = row.split(",");
    if (cols.length < 4) continue;
    const name = cols[0].trim();
    if (!name) continue;
    const num = (v) => {
      const n = Number(String(v).trim());
      return Number.isFinite(n) ? n : null;
    };
    const kcal = num(cols[3]);
    if (kcal === null) continue;
    out.push({
      name,
      kj: num(cols[2]),
      kcal,
      protein: num(cols[4]),
      fat: num(cols[5]),
      carb: num(cols[6]),
      sodium: num(cols[7]),
      calcium: num(cols[8]),
    });
  }
  return out;
}

function normalizeNutrition(o) {
  if (!o || !o.productName) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    name: o.productName,
    kj: num(o.energyKj),
    kcal: num(o.energyKcal),
    protein: num(o.protein),
    fat: num(o.fat),
    carb: num(o.carbohydrate),
    sodium: num(o.sodium),
    calcium: num(o.calcium),
  };
}

/** 取全部营养表，返回 name → 营养 的映射。 */
export async function nutritionMap() {
  const raw = await mcd.nutrition();
  const list = parseNutrition(raw);
  const map = new Map();
  for (const n of list) map.set(n.name, n);
  return { list, map };
}

/**
 * 按名称模糊匹配热量（麦当劳餐品名与营养表名不完全一致，需容错）。
 */
export function lookupKcal(map, name) {
  if (!map || !name) return null;
  if (map.has(name)) return map.get(name);
  // 去掉常见后缀再试
  const cleaned = name.replace(/[（(].*?[)）]/g, "").replace(/\s/g, "");
  for (const [k, v] of map) {
    const kk = k.replace(/[（(].*?[)）]/g, "").replace(/\s/g, "");
    if (kk === cleaned) return v;
  }
  // 包含匹配（取最长公共子串方向）
  let best = null;
  for (const [k, v] of map) {
    if (cleaned.includes(k) || k.includes(cleaned)) {
      if (!best || k.length > best[0].length) best = [k, v];
    }
  }
  return best ? best[1] : null;
}
