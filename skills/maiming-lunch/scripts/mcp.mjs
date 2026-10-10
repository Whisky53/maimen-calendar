/**
 * 麦当劳 MCP 适配层（真实接口，已端到端联调通过）。
 *
 * 协议：Streamable HTTP（JSON-RPC 2.0），接入地址 https://mcp.mcd.cn
 * 鉴权：Authorization: Bearer <MCP_TOKEN>
 * Token 来源：环境变量 MCD_MCP_TOKEN（绝不写入源码 / 仓库 / 日志）
 *
 * 真实调用链（到店自取）：
 *   query-nearby-stores(city)  → 得 storeCode / beCode
 *   query-meals(storeCode)     → 得真实菜单 + 价格
 *   calculate-price(storeCode, items[{productCode,quantity}]) → 得应付金额（单位：分）
 *
 * ⚠️ 已实测确认的接口事实（勿凭猜测改动）：
 *   - items 的商品字段名是 productCode（不是 code），quantity 为整数
 *   - calculate-price 返回的 price / originalPrice / discount 单位是「分」
 *   - query-meals 返回 currentPrice / originalPrice 是「元」字符串
 *   - query-meals 返回结构：data.categories[] + data.meals{code: 详情}
 *   - 响应同时存在于 result.content[0].text 与 result.structuredContent
 *
 * 无 Token 时所有调用降级为 null，由上层回退到演示数据，保证本地可跑。
 */

const MCP_URL = process.env.MCD_MCP_URL || "https://mcp.mcd.cn";
const TOKEN = process.env.MCD_MCP_TOKEN || "";

/** 是否具备真实 MCP 能力。 */
export function hasMcp() {
  return Boolean(TOKEN);
}

/** 默认到店自取场景参数（真实接口必填）。 */
export const STORE_CONTEXT = { beType: 1, orderType: 1 };

let reqId = 0;

/**
 * 调用一个 MCP tool，返回 structuredContent.data（无则回退解析 text）。
 * @param {string} name  tool 名，如 query-meals
 * @param {object} args  参数
 */
export async function callTool(name, args = {}) {
  if (!TOKEN) return null;
  reqId += 1;
  const body = {
    jsonrpc: "2.0",
    id: reqId,
    method: "tools/call",
    params: { name, arguments: args },
  };
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // 401 Token 失效 / 429 限流；错误信息中绝不回显 Token
    throw new Error(`MCP ${name} 调用失败：HTTP ${res.status}`);
  }
  const text = await res.text();
  return extractData(parseMcpText(text), name);
}

/** 兼容 application/json 与 text/event-stream 两种响应。 */
function parseMcpText(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    return unwrap(JSON.parse(trimmed));
  }
  // SSE：取最后一条 data:
  const lines = trimmed.split(/\r?\n/).filter((l) => l.startsWith("data:"));
  for (let i = lines.length - 1; i >= 0; i--) {
    const payload = lines[i].slice(5).trim();
    if (!payload) continue;
    try {
      return unwrap(JSON.parse(payload));
    } catch {
      /* 继续找下一条 */
    }
  }
  return null;
}

function unwrap(j) {
  if (j.error) throw new Error(`MCP 错误：${j.error.message || JSON.stringify(j.error)}`);
  const r = j.result;
  if (!r) return null;
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
 * 业务失败（success:false）会抛出带 code/message 的错误，便于上层降级。
 */
function extractData(sc, name) {
  if (!sc || typeof sc !== "object") return sc;
  if (sc.success === false) {
    throw new Error(`MCP ${name} 业务失败 ${sc.code || ""}：${sc.message || "未知错误"}`);
  }
  return "data" in sc ? sc.data : sc;
}

/** 列出可用工具（联调时验证权限用）。 */
export async function listTools() {
  return callMethod("tools/list", {});
}

async function callMethod(method, params) {
  if (!TOKEN) return null;
  reqId += 1;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }),
  });
  if (!res.ok) throw new Error(`MCP ${method} 失败：HTTP ${res.status}`);
  return parseMcpText(await res.text());
}

// ---- 具体业务封装（对应麦当劳 MCP 官方 Tool，参数名已对齐真实接口）----

export const mcd = {
  /** 到店可点餐门店：需要 city 或 keyword + searchType */
  nearbyStores: (params) => callTool("query-nearby-stores", { beType: 1, searchType: 1, ...params }),
  /** 真实菜单：storeCode 必填 */
  meals: (params) => callTool("query-meals", { ...STORE_CONTEXT, ...params }),
  mealDetail: (params) => callTool("query-meal-detail", { ...STORE_CONTEXT, ...params }),
  storeCoupons: (params) => callTool("query-store-coupons", { ...STORE_CONTEXT, ...params }),
  myCoupons: (params) => callTool("query-my-coupons", { ...params }),
  availableCoupons: (params) => callTool("available-coupons", { ...params }),
  autoBindCoupons: () => callTool("auto-bind-coupons", {}),
  /** 价格试算：items 必须用 productCode */
  calculatePrice: (params) => callTool("calculate-price", { ...STORE_CONTEXT, ...params }),
  myAccount: () => callTool("query-my-account", {}),
  campaignCalendar: (params) => callTool("campaign-calendar", { ...params }),
  nutrition: (params) => callTool("list-nutrition-foods", { ...params }),
  now: () => callTool("now-time-info", {}),
};

// ---- 数据归一化：把真实接口形态转成推荐引擎认识的内部结构 ----

/**
 * 归一化 query-meals 的返回为餐品数组。
 * 真实返回：{ categories:[{name,meals:[{code}]}], meals: { code: {name,currentPrice,...} } }
 * @returns {Array<{code,name,price,category,image,temp,spicy,drink}>}
 */
export function normalizeMenu(raw, { categoryHint = null } = {}) {
  if (!raw) return [];
  // 兼容两种形态：① {categories,meals} ② 直接数组
  const mapping = raw.meals && typeof raw.meals === "object" ? raw.meals : null;
  const categories = Array.isArray(raw.categories) ? raw.categories : null;

  const byCode = new Map();
  if (mapping) {
    for (const [code, m] of Object.entries(mapping)) {
      byCode.set(code, { ...m, code });
    }
  } else if (Array.isArray(raw)) {
    for (const m of raw) {
      const code = m.code || m.productCode;
      if (code) byCode.set(String(code), m);
    }
  }

  // code → 分类名
  const codeCategory = new Map();
  if (categories) {
    for (const c of categories) {
      for (const m of c.meals || []) {
        if (m && m.code) codeCategory.set(String(m.code), c.name);
      }
    }
  }

  const out = [];
  for (const [code, m] of byCode) {
    const priceYuan = Number(m.currentPrice ?? m.price ?? 0) || 0;
    const price = Math.round(priceYuan * 100); // 元 → 分，与 calculate-price 统一
    const category = codeCategory.get(code) || categoryHint || "其他";
    const name = m.name || m.productName || `餐品${code}`;
    out.push({
      code,
      name,
      price,
      originalPrice: Math.round((Number(m.originalPrice) || priceYuan) * 100),
      discountType: m.discountType || null,
      category,
      image: m.image || null,
      ...inferTraits(name, category),
    });
  }
  return out;
}

/** 从名称/分类推断冷热、辣度、是否饮品、是否主食（用于推荐引擎过滤）。 */
export function inferTraits(name = "", category = "") {
  const isDrink =
    /饮品|麦咖啡|可乐|雪碧|红茶|咖啡|牛奶|橙|果汁|茶|水|拿铁|美式|摩卡|奶昔|奶铁|纯悦/.test(name) ||
    /饮品|麦咖啡/.test(category);
  // 明确的正餐主食：堡 / 卷 / 鸡肉类 / 饭 / 牛鱼
  const isMain =
    !isDrink &&
    /汉堡|堡|鸡腿|鸡块|鸡翅|脆汁鸡|炸鸡|卷|饭|牛|鱼|麦乐鸡|麦香鸡|板烧|双全盒|套餐|三件套/.test(name);
  // 明确不属于正餐的零碎：派 / 饼干 / 薯饼 / 酱 / 周边
  const isSnackOnly = /派$|饼干|薯饼|蘸酱|酱$|周边|公仔|玩具|冰淇淋|新地|麦旋风|圣代/.test(name);
  const isCold = /冰|雪碧|可乐|冰摇|冷萃|冰淇淋|新地|麦旋风|圣代|奶昔/.test(name);
  const isHot = /热|原味|经典|拿铁|美式|摩卡|红茶|豆浆|咖啡|牛奶|粥|汤/.test(name) && !isCold;
  const spicy = /辣|麻辣|香辣|椒/.test(name);
  return {
    drink: isDrink,
    temp: isDrink ? (isCold ? "cold" : isHot ? "hot" : "any") : "any",
    spicy,
    main: isMain && !isSnackOnly,
  };
}

/**
 * 抽取真实菜单里的"饮品"和"主食"，用于组装套餐候选。
 */
export function splitMenu(menu) {
  const mains = menu.filter((m) => m.main && !m.drink);
  const drinks = menu.filter((m) => m.drink);
  const sides = menu.filter((m) => !m.main && !m.drink);
  return { mains, drinks, sides };
}

/** 套餐类关键词：名称含这些词的餐品本身就是"成套组合"，应作为推荐单元。 */
const COMBO_PATTERN = /套餐|三件套|四件套|双人餐|单人餐|拼盘|随心拼|双全盒|组合|桶/;
/** 排除明显不适合当午餐主体的：周边、饼干、酱、单杯饮品等。 */
const NOT_MEAL_PATTERN =
  /周边|饼干|蘸酱|酱|玩具|公仔|限定周边|牛奶|果汁|可乐|雪碧|红茶|咖啡|拿铁|美式|摩卡|奶茶|水|茶$/;

/**
 * 从真实菜单里提取「套餐候选」——优先用官方套餐，而不是把单品乱拼。
 * @param {Array} menu normalizeMenu 的产物
 * @returns {Array<{code,name,price,category,tags,isCombo}>}
 */
export function comboCandidates(menu) {
  const out = [];
  for (const m of menu) {
    if (NOT_MEAL_PATTERN.test(m.name)) continue;
    const isCombo = COMBO_PATTERN.test(m.name);
    out.push({ ...m, isCombo });
  }
  return out;
}

/**
 * 为推荐引擎生成更合适的候选池：
 * 1) 优先取官方套餐（isCombo）——这是"一顿饭"的自然单元
 * 2) 若套餐不足，再用「硬主食 + 饮品」拼出少量合理搭配
 *
 * 关键：候选必须是"能当一顿午饭"的，不能把单杯牛奶/单包饼干/派当推荐。
 * @param {Array} menu normalizeMenu 的产物
 * @param {number} budgetCents 预算（分）
 */
export function buildCandidates(menu, budgetCents = Infinity) {
  // 官方套餐：名称含"套餐/三件套/盒/拼盘"等，且不是周边/酱/饼干
  const combos = comboCandidates(menu).filter((m) => m.isCombo && m.price <= budgetCents);
  if (combos.length >= 3) return combos;

  // 兜底：真实"硬主食"（堡/鸡/卷/饭类）+ 最便宜饮品
  const { mains, drinks } = splitMenu(menu);
  const cheapDrinks = drinks
    .filter((d) => d.price <= budgetCents)
    .sort((a, b) => a.price - b.price);
  const solidMains = mains
    .filter((m) => m.price <= budgetCents)
    .sort((a, b) => a.price - b.price)
    .slice(0, 6);
  const built = [];
  for (const m of solidMains) {
    const d = cheapDrinks.find((x) => m.price + x.price <= budgetCents);
    if (!d) continue;
    built.push({
      code: m.code,
      name: `${m.name} + ${d.name}`,
      price: m.price + d.price,
      category: "搭配",
      isCombo: false,
      comboItems: [
        { productCode: m.code, quantity: 1 },
        { productCode: d.code, quantity: 1 },
      ],
      drink: true,
      temp: d.temp,
      spicy: m.spicy,
      main: m.name,
    });
  }
  return [...combos, ...built];
}

/**
 * 从套餐候选里取真实比价所需的 items 数组。
 * 官方套餐直接用其 code 下单；自拼搭配用 comboItems。
 */
export function itemsForCandidate(c) {
  if (Array.isArray(c.comboItems)) return c.comboItems;
  return [{ productCode: c.code, quantity: 1 }];
}

/**
 * 比价：对一组候选组合分别精算应付金额，返回最低价方案。
 * @param {Array<{items:Array, label?:string}>} candidates  items 为 [{productCode,quantity}]
 * @param {object} base  calculate-price 的公共参数（storeCode 等）
 */
export async function comparePrices(candidates, base = {}) {
  if (!TOKEN) return null;
  const results = [];
  for (const c of candidates) {
    try {
      const quote = await mcd.calculatePrice({ ...base, items: c.items });
      if (!quote) continue;
      // 真实接口：price 单位为分
      const payableCents =
        quote.price ?? quote.payableCents ?? quote.totalCents ?? null;
      results.push({ ...c, quote, payableCents });
    } catch (e) {
      results.push({ ...c, error: e.message, payableCents: null });
    }
  }
  const valid = results.filter((r) => typeof r.payableCents === "number");
  valid.sort((a, b) => a.payableCents - b.payableCents);
  return { best: valid[0] || null, all: results };
}
