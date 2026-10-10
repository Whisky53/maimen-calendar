/**
 * 麦当劳 MCP 业务适配层（maimen-meal）。
 *
 * 传输层（callTool / 响应解包 / SSE 兼容）在 skills/shared/mcp-client.mjs，
 * 本文件只负责「麦当劳业务语义」：工具封装、菜单归一化、候选组装、比价。
 *
 * 真实调用链（到店自取）：
 *   query-nearby-stores(city)  → 得 storeCode / beCode
 *   query-meals(storeCode)     → 得真实菜单 + 价格
 *   calculate-price(storeCode, items[{productCode,quantity}]) → 得应付金额（单位：分）
 *
 * 接口字段事实见 references/mcd-tools.md。无 Token 时调用返回 null，
 * 上层据此标记 status=demo，绝不伪装成真实结果。
 */

import { callTool, hasMcp, listTools } from "../../shared/mcp-client.mjs";
import { yuanToCents } from "../../shared/money.mjs";

export { callTool, hasMcp, listTools };
export const TOKEN = process.env.MCD_MCP_TOKEN || "";

/** 默认到店自取场景参数（真实接口必填）。 */
export const STORE_CONTEXT = { beType: 1, orderType: 1 };

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
    // 价格缺失时保留 null（= unknown），绝不按 0 处理
    const priceRaw = m.currentPrice ?? m.price ?? null;
    const price = yuanToCents(priceRaw);
    const origRaw = m.originalPrice ?? null;
    const originalPrice = yuanToCents(origRaw);
    const category = codeCategory.get(code) || categoryHint || "其他";
    const name = m.name || m.productName || `餐品${code}`;
    out.push({
      code,
      name,
      price,
      priceStatus: price === null ? "unknown" : "verified",
      originalPrice,
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
 * 为推荐引擎生成候选池。
 *
 * 选择顺序（不因数量少而放宽价格门槛——预算硬上限不可突破）：
 *   1) 官方套餐（isCombo）中「价格已知且已知价 ≤ 预算」的部分
 *   2) 若套餐不足，用「硬主食 + 饮品」拼出合理搭配补充
 *   3) 补充后仍为空 → 返回 []，由上层返回「预算内无解」，绝不回退到全菜单
 *
 * 价格未知（null）的候选不参与预算内候选池，避免「先按标价筛、核价后又不一致」。
 *
 * @param {Array} menu normalizeMenu 的产物
 * @param {number} budgetCents 预算（分）；Infinity 表示不限
 * @returns {Array} 候选数组，可能为空
 */
export function buildCandidates(menu, budgetCents = Infinity) {
  const affordable = (m) =>
    typeof m.price === "number" && Number.isFinite(m.price) && m.price <= budgetCents;

  const combos = comboCandidates(menu).filter((m) => m.isCombo && affordable(m));
  if (combos.length >= 3) return combos;

  // 补充：真实"硬主食"（堡/鸡/卷/饭类）+ 最便宜饮品
  const { mains, drinks } = splitMenu(menu);
  const cheapDrinks = drinks.filter(affordable).sort((a, b) => a.price - b.price);
  const solidMains = mains.filter(affordable).sort((a, b) => a.price - b.price).slice(0, 6);
  const built = [];
  for (const m of solidMains) {
    const d = cheapDrinks.find((x) => m.price + x.price <= budgetCents);
    if (!d) continue;
    built.push({
      code: m.code,
      name: `${m.name} + ${d.name}`,
      price: m.price + d.price,
      priceStatus: "verified",
      originalPrice: (m.originalPrice ?? m.price) + (d.originalPrice ?? d.price),
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
  // 只返回合格集合；可能为空（上层据此返回无解），不回退全菜单
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
 * 比价：对一组候选组合分别精算应付金额（单位：分）。
 *
 * 每个结果都带 status，便于上层按对象标记来源：
 *   - verified：calculate-price 成功返回，payableCents 为整数分
 *   - failed  ：该候选核价失败（网络/业务错误），payableCents 为 null，附 error
 *   - skipped ：无 Token，未做核价，payableCents 为 null
 *
 * 失败候选保留在 all 里（不静默丢弃），最终推荐只从 verified 中选。
 *
 * @param {Array<{items:Array, label?:string}>} candidates items 为 [{productCode,quantity}]
 * @param {object} base calculate-price 的公共参数（storeCode 等）
 */
export async function comparePrices(candidates, base = {}) {
  if (!TOKEN) {
    return {
      best: null,
      all: candidates.map((c) => ({ ...c, payableCents: null, status: "skipped" })),
      status: "skipped",
    };
  }
  const results = [];
  for (const c of candidates) {
    try {
      const quote = await mcd.calculatePrice({ ...base, items: c.items });
      if (!quote) {
        results.push({ ...c, payableCents: null, status: "failed", error: "空响应" });
        continue;
      }
      // 真实接口：price 单位为分
      const payableCents = quote.price ?? quote.payableCents ?? quote.totalCents ?? null;
      results.push({
        ...c,
        quote,
        payableCents: typeof payableCents === "number" ? payableCents : null,
        status: typeof payableCents === "number" ? "verified" : "failed",
      });
    } catch (e) {
      results.push({ ...c, error: e.message, payableCents: null, status: "failed" });
    }
  }
  const valid = results.filter((r) => r.status === "verified");
  valid.sort((a, b) => a.payableCents - b.payableCents);
  return { best: valid[0] || null, all: results, status: valid.length ? "verified" : "failed" };
}
