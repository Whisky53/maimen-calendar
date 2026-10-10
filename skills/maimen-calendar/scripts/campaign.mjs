/**
 * 活动力度评分引擎。
 *
 * 数据来源：
 *   - campaign-calendar（麦当劳 MCP）：当月活动日历，含每天的活动标题/内容/事件类型
 *   - query-store-coupons / available-coupons：门店可用券与可领券
 *
 * 目标：把"今天麦当劳划不划算"变成一个可比较的分数（0–100）+ 可解释理由。
 *
 * 评分为启发式（heuristic），不是官方优惠金额，输出必须注明"力度为估算"。
 */

/**
 * 从活动文本里嗅探优惠力度的关键词。
 *
 * 分两族：
 *   - kind: "price"   —— 真金白银（明确标价/免单/买赠/半价/优惠字眼/会员价）
 *   - kind: "content" —— 只赚吆喝（上新/回归/联名/线下活动/会员卡）
 *
 * ⚠️ 调参原则（2026-10-10 按使用者反馈调整）：
 *   内容型适度降权 —— 联名/周边/新品不带价格信息，不该和"9.9元早餐"同档。
 *   内容型满分上限同步从 22 降到 15（见 scoreDay 的 contentCapped）。
 */
const KEYWORD_BOOST = [
  // 免单 / 半价 优先级最高（真·白嫖）
  { re: /免费|免单|白吃|霸王餐|0\s*元/, score: 30, label: "免单类", kind: "price" },
  { re: /买一送一|第二份(?:半价|0元|免费)|\b1\s*\+\s*1\b/, score: 26, label: "买赠类", kind: "price" },
  { re: /(?:五折|5\s*折|半价|半折)/, score: 24, label: "半价类", kind: "price" },
  // ⚠️ 加价换购：是"多花 N 元换周边"，不是省钱，单独低权重计，且不再被「明确标价」重复计
  { re: /加\s*\d+(?:\.\d+)?\s*元(?:即可)?(?:得|换|换购|获得)/, score: 8, label: "加价换购", kind: "price" },
  // 明确标价：9.9元 / ¥9.9 / 13.9r（已归一化为元）
  { re: /(\d+(?:\.\d+)?)\s*元/, score: 22, label: "明确标价", kind: "price", skipIf: /加\s*\d+(?:\.\d+)?\s*元(?:即可)?(?:得|换|换购|获得)/ },
  { re: /[¥￥]\s*\d+(?:\.\d+)?/, score: 22, label: "明确标价", kind: "price" },
  { re: /优惠|满减|立减|特价|超值|划算|省|折扣/, score: 14, label: "优惠字眼", kind: "price" },
  { re: /会员日|会员专享|会员价/, score: 16, label: "会员专属", kind: "price" },
  { re: /卡$|学期卡|早餐卡|金卡|月卡/, score: 10, label: "会员卡", kind: "price" },
  // 内容型：仅作"这天有热闹"的加分，权重下调（原 12/10/9/8 → 7/6/5/4）
  { re: /上新|新品|限量|首发|新口味/, score: 7, label: "新品上市", kind: "content" },
  { re: /回归|返场|限时|即将结束/, score: 6, label: "限时回归", kind: "content" },
  { re: /联名|联动|周边|限定/, score: 5, label: "联名周边", kind: "content" },
  { re: /派对|体验营|亲子|体验/, score: 4, label: "线下活动", kind: "content" },
];

/** 标题指纹：用于跨天去重（归一化数字 + 去符号 + 截断）。 */
export function titleKey(title) {
  return normalizeDigits(title || "")
    .replace(/[\s。，、！？~～\-—_·「」【】（）()💥🔥✨🩶🫐😋🥳📣💳❤️]/gu, "")
    .slice(0, 20);
}

/** 事件类型权重（MCP eventType 语义，实测 4 = 常规营销活动）。 */
const EVENT_TYPE_WEIGHT = {
  1: 1.4,
  2: 1.2,
  3: 1.1,
  4: 1.0,
};

/**
 * 营销文案里的"花式数字"归一化。
 *
 * ⚠️ 实测踩坑：麦当劳文案常用数学粗体数字，如「超值𝟗.𝟗元早餐」。
 * 𝟗 是 U+1D7D7（MATHEMATICAL BOLD DIGIT NINE），既不是半角 9 也不是全角 ９，
 * 普通 /[0-9]/ 完全匹配不到，导致"明确的 9.9 元低价"被判成"无优惠"。
 *
 * 这里把四类数字统一转成半角：
 *   - 全角 ０-９ (U+FF10–FF19)
 *   - 数学粗体 𝟎-𝟗 (U+1D7CE–1D7D7)
 *   - 数学粗斜体 𝟘-𝟡 (U+1D7D8–1D7E1)
 *   - 数学等宽 𝟶-𝟿 (U+1D7F6–1D7FF)
 * 另外把网络写法「13.9r」(r=元) 补成「13.9元」。
 */
export function normalizeDigits(s) {
  if (s == null) return "";
  let out = String(s);
  const map = (from, to, base) => {
    out = out.replace(new RegExp(`[\\u{${from.toString(16)}}-\\u{${to.toString(16)}}]`, "gu"), (c) =>
      String(c.codePointAt(0) - base)
    );
  };
  map(0xff10, 0xff19, 0xff10); // 全角
  map(0x1d7ce, 0x1d7d7, 0x1d7ce); // 粗体
  map(0x1d7d8, 0x1d7e1, 0x1d7d8); // 粗斜体
  map(0x1d7f6, 0x1d7ff, 0x1d7f6); // 等宽
  // 网络写法：13.9r / 13.9R / 13块9 → 补上"元"以便统一匹配
  out = out.replace(/(\d+(?:\.\d+)?)\s*[rR](?![a-zA-Z])/g, "$1元");
  return out;
}

/**
 * 给一天打分。
 *
 * ⚠️ 关键设计：
 * 1) 区分「优惠型」与「内容型」——事件多 ≠ 力度大，上新/联名不代表省钱。
 * 2) 文案数字先归一化（花式数字陷阱，见 normalizeDigits）。
 * 3) **同一天内按标题去重**：campaign-calendar 会把同一活动在多个日期反复推送，
 *    同一天里也可能出现同一活动的多个条目，必须去重后再计分。
 * 4) 分数封顶后再做「饱和度衰减」，避免"活动堆砌"线性刷分。
 */
export function scoreDay(day, opts = {}) {
  const rawEvents = Array.isArray(day.events) ? day.events : [];
  const coupons = Array.isArray(opts.coupons) ? opts.coupons : [];

  // ① 同一天内按「归一化标题」去重
  const seen = new Set();
  const events = [];
  for (const e of rawEvents) {
    const art = e.articleDto || {};
    const rawTitle = art.title || e.activityTitle || "";
    const key = normalizeDigits(rawTitle).replace(/\s+/g, "").slice(0, 24);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    events.push(e);
  }

  let priceScore = 0;
  let contentScore = 0;
  const reasons = [];
  const titles = [];

  for (const e of events) {
    const art = e.articleDto || {};
    const title = art.title || e.activityTitle || "";
    const content = art.content || "";
    // ② 数字归一化后再匹配
    const text = normalizeDigits(`${title} ${content}`);
    if (title) titles.push(normalizeDigits(title).replace(/\s+/g, " ").trim());

    const typeW = EVENT_TYPE_WEIGHT[e.eventType] || 1.0;
    let evPrice = 0;
    let evContent = 4 * typeW; // 基础内容分（原 6，下调）
    const priceHits = [];
    const contentHits = [];
    for (const k of KEYWORD_BOOST) {
      if (!k.re.test(text)) continue;
      // skipIf：命中更具体规则时，让泛化的"明确标价"让位，避免双重计分
      // （如「加39.9元即可得周边」已按"加价换购"计，不再按"明确标价"重复计）
      if (k.skipIf && k.skipIf.test(text)) continue;
      if (k.kind === "price") {
        evPrice += k.score;
        priceHits.push(k.label);
      } else {
        evContent += k.score;
        contentHits.push(k.label);
      }
    }
    if (priceHits.length > 2) evPrice *= 0.8;
    if (contentHits.length > 3) evContent *= 0.8;

    priceScore += evPrice;
    contentScore += evContent;

    const hits = [...priceHits, ...contentHits];
    if (hits.length) reasons.push(`${title.slice(0, 18)}… → ${hits.join("、")}`);
  }

  if (coupons.length) {
    const couponScore = Math.min(24, coupons.length * 5);
    priceScore += couponScore;
    reasons.push(`门店可用券 ${coupons.length} 张（+${Math.round(couponScore)}）`);
  }

  // ③ 饱和衰减：优惠分越高，边际增益越小（避免堆砌活动刷满分）
  const pricePart = 100 * (1 - Math.exp(-priceScore / 45));
  // 内容型封顶 15（原 22）——纯造势不带价格的活动，最多只值"有点小惊喜"
  const contentCapped = Math.min(15, contentScore * 0.45 + Math.log2(events.length + 1) * 5);
  const score = Math.min(100, Math.round(pricePart * 0.82 + contentCapped));

  const priceLabel =
    priceScore >= 40 ? "优惠明确" : priceScore >= 18 ? "有些优惠" : "以内容活动为主";

  return {
    date: day.date,
    isToday: Boolean(day.today),
    eventCount: events.length,
    rawEventCount: rawEvents.length,
    deduped: rawEvents.length - events.length,
    score,
    level: levelOf(score),
    title: titles[0] || "无特别活动",
    titles,
    reasons,
    priceScore: Math.round(priceScore),
    priceLabel,
  };
}

/**
 * 分数 → 力度档位（5 档，2026-10-10 按实测分布重设阈值）。
 *
 * 实测分数分布原本是「83 / 69 / 59 / 53 / 49 → 全挤在不错档，20 以下全叫平淡」，
 * 25–45 无样本，档位没有区分度。重设后：
 *   80+ 大力🔥   —— 超级活动日（如 10-10 蘸酱上新+多券叠加）
 *   60+ 值得去✨ —— 明确的低价活动（如 9.9元早餐 + 联名）
 *   35+ 小惊喜🙂 —— 有点优惠或多个内容活动
 *   18+ 平平💤   —— 只有单个内容活动
 *   <18 无活动    —— 基本没活动，按常规吃
 */
export function levelOf(score) {
  if (score >= 80) return { key: "great", label: "大力", emoji: "🔥" };
  if (score >= 60) return { key: "good", label: "值得去", emoji: "✨" };
  if (score >= 35) return { key: "fair", label: "小惊喜", emoji: "🙂" };
  if (score >= 18) return { key: "mild", label: "平平", emoji: "💤" };
  return { key: "none", label: "无活动", emoji: "😐" };
}

/**
 * 判断某一天是不是"往期回顾"（活动已结束，不该进入推荐）。
 *
 * ⚠️ 实测：campaign-calendar 的 dailyList 同时包含未来活动和已结束的往期活动。
 * 往期日的 dateText 形如「2026年10月7日 往期回顾」，必须剔除，
 * 否则 10-07 的"9.9元早餐"会被当成"未来值得吃的一天"推给用户。
 */
export function isPastDay(day) {
  const text = String((day && day.dateText) || "");
  if (/往期|回顾|已结束|已过期/.test(text)) return true;
  // 双保险：日期本身早于今天
  const d = String((day && day.date) || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < todayStr()) return true;
  return false;
}

/**
 * 给整个日历评分，并挑出「未来最值得吃的一天」。
 *
 * ⚠️ 跨天去重：campaign-calendar 会把同一长期活动（如"9.9元早餐"）
 * 在其覆盖的每一天都推一遍。若每天都按"新优惠"计分，会导致
 * 长期活动把整月分数拉平。这里只在该活动**首次出现的日期**计全分，
 * 之后出现的同一活动降权为"持续中"（×0.35），并在标题上标注。
 *
 * ⚠️ 往期剔除：isPastDay 为真的日期不进入 upcoming / best / top，
 * 避免把已结束的活动推荐成"接下来最值得吃的一天"。
 *
 * @param {object} calendar campaign-calendar 的 data
 * @param {object} [opts] { coupons, upcomingOnly, includePast, limit }
 */
export function scoreCalendar(calendar, opts = {}) {
  const list = (calendar && calendar.dailyList) || [];
  const coupons = opts.coupons || [];

  // 按日期升序，保证"首次出现"判断正确
  const ordered = [...list].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const firstSeen = new Map(); // titleKey → 首次出现日期

  const scored = ordered.map((day) => {
    const d = scoreDay(day, { coupons });
    // 标记每条活动是"新"还是"持续中"
    const newTitles = [];
    const ongoingTitles = [];
    for (const t of d.titles) {
      const k = titleKey(t);
      if (!k) continue;
      if (!firstSeen.has(k)) {
        firstSeen.set(k, day.date);
        newTitles.push(t);
      } else if (firstSeen.get(k) !== day.date) {
        ongoingTitles.push(t);
      }
    }
    const ongoingRatio = d.titles.length ? ongoingTitles.length / d.titles.length : 0;
    const adjusted = Math.round(d.score * (1 - ongoingRatio * 0.65));
    return {
      ...d,
      isPast: isPastDay(day),
      dateText: day.dateText || "",
      score: ongoingRatio > 0 ? adjusted : d.score,
      level: levelOf(ongoingRatio > 0 ? adjusted : d.score),
      newCount: newTitles.length,
      ongoingCount: ongoingTitles.length,
      ongoingTitles,
    };
  });

  const today = todayStr();
  // 未来窗口：默认剔除往期，只看今天及以后
  let upcoming = scored;
  if (opts.upcomingOnly !== false) {
    upcoming = scored.filter((d) => d.date >= today && !d.isPast);
  } else if (!opts.includePast) {
    upcoming = scored.filter((d) => !d.isPast);
  }
  const sorted = [...upcoming].sort((a, b) => b.score - a.score);
  const best = sorted[0] || null;
  const todayScored = scored.find((d) => d.date === today) || null;

  // 全月最优惠日（只在未过期的日子里挑，供"什么时候去吃"参考）
  const bestOverall =
    [...scored].filter((d) => !d.isPast).sort((a, b) => b.score - a.score)[0] || null;

  // 推荐只看"够格"的日子：低于此分说明这几天真的没活动，
  // 与其把 5 分的日子塞进 TOP5 误导用户，不如老实说"最近没什么特别的"。
  const recommendFloor = opts.recommendFloor ?? 20;
  const noteworthy = sorted.filter((d) => d.score >= recommendFloor);

  return {
    all: scored,
    upcoming,
    past: scored.filter((d) => d.isPast),
    today: todayScored,
    best: noteworthy[0] || null,
    bestOverall,
    noteworthy,
    recommendFloor,
    top: noteworthy.slice(0, opts.limit || 5),
  };
}

/** 本地日期 YYYY-MM-DD（避免 UTC 偏移）。 */
export function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 给日期加天数。 */
export function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return todayStr(d);
}

/**
 * 力度 → 推荐权重调整：大力日更值得推荐"贵的 / 新品"，平淡日回归性价比。
 */
/**
 * 活动力度 → 偏好倾向。
 *
 * 注意（需求说明书 §13.2）：**预算为硬上限，任何档位都不放大预算**。
 * 活动力度只影响「同样预算内更偏向尝鲜/升级」这一排序倾向，不改变可选范围。
 * @returns {{prefTrend:number, note:string}}
 */
export function levelToBias(level) {
  switch (level && level.key) {
    case "great":
      return { prefTrend: 1.5, note: "活动力度大，同样预算内可优先尝鲜款" };
    case "good":
      return { prefTrend: 1.2, note: "有明确的低价活动，同预算内可优先活动款" };
    case "fair":
      return { prefTrend: 1.0, note: "有点小优惠，按常规选即可" };
    case "mild":
      return { prefTrend: 0.9, note: "活动平平，走性价比路线" };
    default:
      return { prefTrend: 0.8, note: "基本没活动，吃常规款就好" };
  }
}
