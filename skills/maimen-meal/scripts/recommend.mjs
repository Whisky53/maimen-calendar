/**
 * 推荐引擎：在硬约束内筛选候选，按软偏好排序，再在最优档里抽签。
 *
 * 与 Web 应用里的 lib/lunch.ts 同一套规则语义，但此版本面向 skill 独立运行：
 * - 餐品来源可以是真实 MCP 查询结果，也可以是内置演示数据。
 * - 硬约束（预算 / 忌口 / 明确排除）永不被软偏好或随机性突破。
 */

/** 内置演示数据（无 MCP Token 时使用）。价格单位为分。 */
export const DEMO_MEALS = [
  { id: "a", name: "准点回血套餐", subtitle: "熟悉的味道，稳定地快乐", main: "板烧鸡腿堡", side: "小份薯条", drink: "热红茶", temp: "hot", price: 2450, spicy: false, sign: "准点回血", motto: "工作可以等一下，午饭不能一直等。" },
  { id: "b", name: "快乐续航套餐", subtitle: "把下午的电量，一口一口补回来", main: "双层吉士汉堡", side: "麦乐鸡 4 块", drink: "冰可乐", temp: "cold", price: 2800, spicy: false, sign: "快乐续航", motto: "今天宜给自己充电，忌空腹接新需求。" },
  { id: "c", name: "打工人基础装备", subtitle: "简简单单，也能吃得开心", main: "吉士汉堡", side: "小份薯条", drink: "热红茶", temp: "hot", price: 1950, spicy: false, sign: "钱包守护", motto: "预算结界稳定，钱包尚有一战之力。" },
  { id: "d", name: "午间燃力补给", subtitle: "来点酥脆，唤醒午后状态", main: "麦辣鸡腿汉堡", side: "小份薯条", drink: "冰可乐", temp: "cold", price: 2650, spicy: true, sign: "状态上线", motto: "今天的高光，可以从午饭开始。" },
  { id: "e", name: "温柔待机套餐", subtitle: "热饮在手，烦恼先放一边", main: "麦香鱼", side: "玉米杯", drink: "热红茶", temp: "hot", price: 2700, spicy: false, sign: "温柔待机", motto: "不必每秒都满格，慢慢吃也很好。" },
  { id: "f", name: "午休小确幸", subtitle: "留点预算，也留点自在", main: "麦香鸡", side: "小份薯条", drink: "冰可乐", temp: "cold", price: 2200, spicy: false, sign: "午休自由", motto: "今日宜离开工位，忌边吃边回收到。" },
];

export const DEFAULT_SETTINGS = {
  budget: 30, // 元
  drink: "any", // any | hot | cold
  noSpicy: false,
  city: "上海",
  mealSlot: null, // breakfast | lunch | dinner | late-night | snack；null = 按当前时间推断
  mealPurpose: "full-meal", // full-meal | light-meal | drink-only
};

/**
 * 餐次定义（需求说明书 §5）：标签、默认时段、默认预算倾向。
 * 时段只用于「未指定时按当前时间推断」，不作为硬约束。
 */
export const MEAL_SLOTS = {
  breakfast: { label: "早餐", from: 5, to: 10, defaultPurpose: "light-meal" },
  lunch: { label: "午餐", from: 10, to: 15, defaultPurpose: "full-meal" },
  dinner: { label: "晚餐", from: 16, to: 22, defaultPurpose: "full-meal" },
  "late-night": { label: "夜宵", from: 22, to: 26, defaultPurpose: "light-meal" },
  snack: { label: "加餐", from: 14, to: 17, defaultPurpose: "light-meal" },
};

/** 用餐目的定义：决定候选池的「份量档位」。 */
export const MEAL_PURPOSES = {
  "full-meal": { label: "正餐", needMain: true, needDrink: false },
  "light-meal": { label: "轻食", needMain: false, needDrink: false },
  "drink-only": { label: "仅饮品", needMain: false, needDrink: true },
};

/**
 * 按当前时间推断餐次。
 * @param {Date} [now]
 */
export function inferSlot(now = new Date()) {
  const h = now.getHours();
  if (h >= 5 && h < 10) return "breakfast";
  if (h >= 10 && h < 15) return "lunch";
  if (h >= 15 && h < 17) return "snack";
  if (h >= 17 && h < 22) return "dinner";
  return "late-night";
}

/**
 * 归一化一份餐品（兼容真实 MCP 返回与演示数据）。
 * @param {object} raw
 * @param {number} idx
 */
export function normalizeMeal(raw, idx) {
  const price =
    typeof raw.priceCents === "number"
      ? raw.priceCents
      : typeof raw.price === "number"
        ? raw.price
        : null; // 缺失保留 null，不按 0
  const text = `${raw.name || ""}${raw.main || ""}${raw.drink || ""}${raw.side || ""}`;
  const temp =
    raw.temp ||
    (/冰|冷/.test(text) ? "cold" : /热|暖/.test(text) ? "hot" : "any");
  return {
    id: raw.id || `mcp-${idx}`,
    name: raw.name || `套餐 ${idx + 1}`,
    subtitle: raw.subtitle || "",
    main: raw.main || raw.name || "",
    side: raw.side || "",
    drink: raw.drink || "",
    temp,
    price,
    priceStatus: raw.priceStatus || (price === null ? "unknown" : "verified"),
    spicy: typeof raw.spicy === "boolean" ? raw.spicy : /辣/.test(text),
    // 是否含主食 / 是否含饮品，供用餐目的判定
    hasMain: raw.main != null ? Boolean(raw.main) : /堡|卷|饭|鸡|牛|鱼|套餐|盒/.test(text),
    hasDrink: Boolean(raw.drink) || /可乐|雪碧|红茶|咖啡|拿铁|美式|奶|汁|茶|水/.test(text),
    isCombo: Boolean(raw.isCombo),
    sign: raw.sign || "",
    motto: raw.motto || "",
  };
}

/**
 * 从历史事件里汇总「明确喜欢 / 不再推荐 / 最近吃过」。
 * 事件形如 { id, kind, payload:{ mealId, value }, createdAt }
 */
export function summarizeHistory(history = []) {
  const latest = new Map();
  for (const e of history) {
    if (e.kind === "feedback" && e.payload && e.payload.mealId) {
      if (!latest.has(e.payload.mealId)) latest.set(e.payload.mealId, e.payload.value);
    }
  }
  const recent = history
    .filter((e) => e.kind === "selected" && e.payload && e.payload.mealId)
    .slice(0, 2)
    .map((e) => e.payload.mealId);
  return { latest, recent };
}

/**
 * 推荐主函数。
 *
 * @param {object} opts
 * @param {object} opts.settings     预算/冷热/不吃辣/餐次/用餐目的
 * @param {Array}  opts.meals        候选餐品（真实或演示）
 * @param {Array}  opts.history      历史事件（见 memory.mjs）
 * @param {string} [opts.previous]   上一套（抽签避重复）
 * @param {object} [opts.preference] derivePreferences 的结果（可选）
 * @param {Set<string>} [opts.excluded] 明确排除的 id
 * @returns {{meal:object|null, count:number, reasons:string[], constraints:object,
 *            slot:string, purpose:string, emptyReason:string|null}}
 */
export function recommend({
  settings,
  meals,
  history = [],
  previous,
  preference,
  excluded = null,
} = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const slot = s.mealSlot || inferSlot();
  const purpose = MEAL_PURPOSES[s.mealPurpose] ? s.mealPurpose : "full-meal";
  const purposeDef = MEAL_PURPOSES[purpose];

  const source = meals && meals.length ? meals : DEMO_MEALS;
  const pool = source.map(normalizeMeal);
  const { latest, recent } = summarizeHistory(history);
  const budgetCents = Math.round(s.budget * 100);

  // 1) 硬约束过滤（预算为硬上限；目的不符者排除；价格未知不进入预算内比较）
  const eligible = pool.filter((m) => {
    if (m.price === null || !Number.isFinite(m.price) || m.price > budgetCents) return false;
    if (s.noSpicy && m.spicy) return false;
    if (s.drink !== "any" && m.temp !== s.drink && m.temp !== "any") return false;
    if (latest.get(m.id) === "dislike") return false;
    if (excluded && excluded.has(m.id)) return false;
    if (purposeDef.needDrink && !m.hasDrink) return false;
    return true;
  });

  // 无解原因分档，便于上层区分「业务无解」与「服务失败」
  let emptyReason = null;
  if (!eligible.length) {
    const knownPrice = pool.filter((m) => m.price !== null);
    if (!knownPrice.length) emptyReason = "所有候选价格未知，无法判定是否在预算内";
    else if (!pool.some((m) => m.price !== null && m.price <= budgetCents))
      emptyReason = `预算内没有候选（最低 ${Math.min(...knownPrice.map((m) => m.price)) / 100} 元）`;
    else if (purposeDef.needDrink && !pool.some((m) => m.hasDrink))
      emptyReason = "没有符合「仅饮品」的候选";
    else emptyReason = "当前条件下没有可行方案";
  }

  // 2) 软偏好打分
  const prefTemp = preference && preference.preferredTemp ? preference.preferredTemp : null;
  const score = (m) => {
    let sc = 0;
    if (latest.get(m.id) === "like") sc += 10;
    if (recent.includes(m.id)) sc -= 3;
    if (m.id === previous) sc -= 20;
    if (prefTemp && prefTemp !== "any" && m.temp === prefTemp) sc += 1.5;
    return sc;
  };
  eligible.sort((a, b) => score(b) - score(a));

  // 3) 只在最优档里抽签，不随机突破约束
  const topScore = eligible.length ? score(eligible[0]) : 0;
  const top = eligible.filter((m) => score(m) === topScore);
  const meal = top.length ? top[Math.floor(Math.random() * top.length)] : null;

  // 4) 生成可解释理由
  const reasons = [];
  if (meal) {
    const left = budgetCents - meal.price;
    reasons.push(`预算内，还剩 ¥${(left / 100).toFixed(2)}`);
    reasons.push(`餐次：${MEAL_SLOTS[slot] ? MEAL_SLOTS[slot].label : slot} · 目的：${purposeDef.label}`);
    if (s.drink === "hot") reasons.push("已按热饮偏好过滤");
    else if (s.drink === "cold") reasons.push("已按冷饮偏好过滤");
    if (s.noSpicy) reasons.push("已避开辣味餐品");
    if (preference && prefTemp && prefTemp !== "any" && meal.temp === prefTemp) {
      const hit = (preference.signals || []).find((x) => x.kind === "temp" && x.value === prefTemp);
      if (hit) reasons.push(hit.reason);
    }
    if (recent.length && !recent.includes(meal.id)) reasons.push("和最近的选择换个口味");
    if (latest.get(meal.id) === "like") reasons.push("你说过下次还想吃");
  }

  return {
    meal,
    count: eligible.length,
    reasons,
    slot,
    purpose,
    emptyReason,
    constraints: {
      budget: s.budget,
      budgetHardLimit: true,
      drink: s.drink,
      noSpicy: s.noSpicy,
      slot,
      purpose,
    },
  };
}
