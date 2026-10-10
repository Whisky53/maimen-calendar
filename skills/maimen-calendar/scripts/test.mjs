#!/usr/bin/env node
/**
 * 麦门日历 · 回归测试（离线，不依赖网络与 Token）。
 *
 * 覆盖：天气分层规则 / 活动力度评分 / 热量计算 / 训练计划 / ICS 规范 / 边界。
 * 运行：node test.mjs
 */
import { weatherPolicy, cityCodeOf, windLevelOf, precipLevelOf } from "./weather.mjs";
import {
  scoreDay,
  scoreCalendar,
  levelOf,
  levelToBias,
  todayStr,
  addDays,
  normalizeDigits,
  titleKey,
  isPastDay,
} from "./campaign.mjs";
import {
  burnOf,
  burnOfPlan,
  bmr,
  tdee,
  balance,
  nutritionScore,
  expandPlan,
  TRAINING_TEMPLATES,
} from "./nutrition.mjs";
import { buildIcs, escapeText, foldLine, scheduleToIcs, toEvent, buildUid } from "./ics.mjs";
import { assert } from "node:console";

let pass = 0;
const failed = [];
function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    failed.push(`${name}: ${e.message}`);
  }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || ""} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function ok(v, msg) {
  if (!v) throw new Error(msg || "断言失败");
}

// ── 天气分层规则 ─────────────────────────────────
check("城市码：中文名", () => eq(cityCodeOf("上海"), "101020100"));
check("城市码：带市字", () => eq(cityCodeOf("北京市"), "101010100"));
check("城市码：数字直通", () => eq(cityCodeOf("101020100"), "101020100"));
check("城市码：未收录返回 null", () => eq(cityCodeOf("不存在市"), null));

check("天气分层：低温推热食", () => {
  const s = weatherPolicy({ tempC: 5 });
  ok(s.some((x) => x.value === "hot"), "5°C 应推 hot");
});
check("天气分层：高温推冰饮", () => {
  const s = weatherPolicy({ tempC: 33 });
  ok(s.some((x) => x.value === "cold"), "33°C 应推 cold");
});
check("天气分层：舒适温度不限", () => {
  const s = weatherPolicy({ tempC: 22 });
  ok(s.some((x) => x.value === "any"), "22°C 应推 any");
});
check("天气分层：降雨加暖胃", () => {
  const s = weatherPolicy({ tempC: 20, precipitation: "rain" });
  ok(s.some((x) => x.kind === "occasion"), "降雨应有 occasion 信号");
});
check("天气分层：自定义阈值", () => {
  const s = weatherPolicy({ tempC: 12 }, { coldMax: 15 });
  ok(s.some((x) => x.value === "hot"), "自定义阈值 15 应让 12°C 推 hot");
});
check("天气分层：AQI 超标提示", () => {
  const s = weatherPolicy({ tempC: 22, aqi: 180 });
  ok(s.some((x) => x.kind === "air"), "AQI 180 应有 air 信号");
});

// ── 天气规则优化（2026-10-10 新增）─────────────────
check("温度四层：严寒权重最高", () => {
  const s = weatherPolicy({ tempC: 3 });
  const t = s.find((x) => x.kind === "temp");
  ok(t && t.value === "hot" && t.weight === 3, `3°C 应为 hot/w3，实际 ${t && t.value}/w${t && t.weight}`);
});
check("温度四层：偏凉走 coldMax 分支", () => {
  const s = weatherPolicy({ tempC: 12 });
  const t = s.find((x) => x.kind === "temp");
  ok(t && t.value === "hot" && t.weight === 2, `12°C 应为 hot/w2，实际 ${t && t.value}/w${t && t.weight}`);
});
check("温度四层：28°C 起推冰饮（原 30）", () => {
  const s = weatherPolicy({ tempC: 28 });
  ok(s.some((x) => x.value === "cold"), "28°C 应推 cold（新阈值）");
});
check("温度四层：酷热权重最高", () => {
  const s = weatherPolicy({ tempC: 37 });
  const t = s.find((x) => x.kind === "temp");
  ok(t && t.weight === 3, `37°C 应为 w3，实际 w${t && t.weight}`);
});
check("降水强弱：暴雨为强暖胃(w2)", () => {
  const s = weatherPolicy({ tempC: 15, precipitation: "rain", precipLevel: "heavy" });
  const oc = s.find((x) => x.kind === "occasion");
  ok(oc && oc.weight === 2, `暴雨应 w2，实际 w${oc && oc.weight}`);
});
check("降水强弱：小雨为弱暖胃(w1)", () => {
  const s = weatherPolicy({ tempC: 15, precipitation: "rain", precipLevel: "light" });
  const oc = s.find((x) => x.kind === "occasion");
  ok(oc && oc.weight === 1, `小雨应 w1，实际 w${oc && oc.weight}`);
});
check("冲突消解：酷热+暴雨 → 主导仍是冰饮，降水转备注", () => {
  const s = weatherPolicy({ tempC: 37, precipitation: "rain", precipLevel: "heavy" });
  const t = s.find((x) => x.kind === "temp");
  const oc = s.find((x) => x.kind === "occasion");
  ok(t && t.value === "cold", "主导应是 cold");
  ok(!oc, "降水不应再作为独立信号");
  ok(s.some((x) => x.kind === "note"), "降水应降级为备注");
});
check("冲突消解：偏凉+暴雨 → 两个信号并存", () => {
  const s = weatherPolicy({ tempC: 10, precipitation: "rain", precipLevel: "heavy" });
  ok(s.some((x) => x.value === "hot"), "应有 hot");
  ok(s.some((x) => x.kind === "occasion"), "应有 occasion");
});
check("AQI 三档：轻度污染走备注", () => {
  const s = weatherPolicy({ tempC: 22, aqi: 120 });
  ok(!s.some((x) => x.kind === "air"), "AQI 120 不应触发 indoor");
  ok(s.some((x) => x.kind === "note"), "AQI 120 应走备注");
});
check("AQI 三档：≥150 走室内信号", () => {
  const s = weatherPolicy({ tempC: 22, aqi: 160 });
  ok(s.some((x) => x.kind === "air"), "AQI 160 应触发 indoor");
});
check("新增信号：大风提示", () => {
  const s = weatherPolicy({ tempC: 22, windLevel: 7 });
  ok(s.some((x) => x.kind === "note" && /大风/.test(x.reason)), "7 级风应有大风备注");
});
check("新增信号：紫外线强强化冰饮", () => {
  const s = weatherPolicy({ tempC: 30, uv: "strong" });
  const t = s.find((x) => x.kind === "temp");
  ok(t && t.weight === 3, `30°C+强紫外线 应从 w2 升到 w3，实际 w${t && t.weight}`);
});
check("风级解析：<3级 → 2", () => eq(windLevelOf("东风转北风 <3级"), 2));
check("风级解析：4-5级 → 5", () => eq(windLevelOf("4-5级"), 5));
check("风级解析：微风 → 2", () => eq(windLevelOf("无持续风向 微风"), 2));

// ── 花式数字归一化 ───────────────────────────────
check("数字归一化：数学粗体 → 半角", () => {
  eq(normalizeDigits("超值𝟗.𝟗元"), "超值9.9元");
});
check("数字归一化：全角 → 半角", () => {
  eq(normalizeDigits("只要９.９元"), "只要9.9元");
});
check("数字归一化：13.9r → 13.9元", () => {
  eq(normalizeDigits("麦咖啡13.9r浓浓黑巧"), "麦咖啡13.9元浓浓黑巧");
});
check("数字归一化：不影响正常英文", () => {
  eq(normalizeDigits("Big Mac"), "Big Mac");
});

// ── 活动力度评分 ─────────────────────────────────
check("力度档位分界（5 档）", () => {
  eq(levelOf(80).key, "great");   // 大力
  eq(levelOf(60).key, "good");    // 值得去
  eq(levelOf(35).key, "fair");    // 小惊喜
  eq(levelOf(18).key, "mild");    // 平平
  eq(levelOf(10).key, "none");    // 无活动
});

check("档位阈值边界精确", () => {
  eq(levelOf(79).key, "good");
  eq(levelOf(59).key, "fair");
  eq(levelOf(34).key, "mild");
  eq(levelOf(17).key, "none");
});

check("优惠型活动得分高于内容型", () => {
  const price = scoreDay({ date: "2026-10-11", events: [{ eventType: 4, articleDto: { title: "9.9元早餐两件套" } }] });
  const content = scoreDay({ date: "2026-10-11", events: [{ eventType: 4, articleDto: { title: "某某联名周边上新" } }] });
  ok(price.score > content.score, `优惠型(${price.score}) 应 > 内容型(${content.score})`);
});

check("免单类关键词加分明显", () => {
  const d = scoreDay({ date: "2026-10-11", events: [{ eventType: 4, articleDto: { title: "抽霸王餐免单" } }] });
  ok(d.score >= 45, `免单活动应得高分，实际 ${d.score}`);
});

check("无活动日得分最低", () => {
  const d = scoreDay({ date: "2026-10-11", events: [] });
  eq(d.eventCount, 0);
  ok(d.score < 15, `无活动应低分，实际 ${d.score}`);
});

check("事件多但都是内容型不会误判为大力", () => {
  const events = Array.from({ length: 10 }, (_, i) => ({
    eventType: 4,
    articleDto: { title: `第${i}款新品上新` },
  }));
  const d = scoreDay({ date: "2026-10-11", events });
  ok(d.score < 70, `10 条内容型活动不应达到"大力"(${d.score})`);
});

check("门店券提升力度分", () => {
  const base = scoreDay({ date: "2026-10-11", events: [] });
  const withCoupons = scoreDay({ date: "2026-10-11", events: [] }, { coupons: [{}, {}, {}] });
  ok(withCoupons.score > base.score, "有券应加分");
});

check("同日去重：同一活动多条只算一次", () => {
  const one = scoreDay({ date: "2026-10-11", events: [{ eventType: 4, articleDto: { title: "9.9元早餐两件套" } }] });
  const dup = scoreDay({
    date: "2026-10-11",
    events: [
      { eventType: 4, articleDto: { title: "9.9元早餐两件套" } },
      { eventType: 4, articleDto: { title: "9.9元早餐两件套" } },
      { eventType: 4, articleDto: { title: "9.9元早餐两件套" } },
    ],
  });
  eq(dup.eventCount, 1);
  eq(dup.score, one.score);
});

check("花式数字参与计分：粗体 9.9元 能识别为优惠", () => {
  const d = scoreDay({ date: "2026-10-11", events: [{ eventType: 4, articleDto: { title: "超值𝟗.𝟗元早餐两件套" } }] });
  ok(d.priceScore >= 20, `粗体 9.9元 应得优惠分，实际 ${d.priceScore}`);
});

check("跨天降权：长期活动第二天降权", () => {
  const today = todayStr();
  const cal = {
    dailyList: [
      { date: addDays(today, 1), events: [{ eventType: 4, articleDto: { title: "9.9元早餐两件套" } }] },
      { date: addDays(today, 2), events: [{ eventType: 4, articleDto: { title: "9.9元早餐两件套" } }] },
    ],
  };
  const r = scoreCalendar(cal);
  const d1 = r.all.find((d) => d.date === addDays(today, 1));
  const d2 = r.all.find((d) => d.date === addDays(today, 2));
  ok(d1.newCount === 1, "首次出现应标为新");
  ok(d2.ongoingCount === 1, "第二天应标为持续中");
  ok(d2.score < d1.score, `持续中应降权（${d2.score} < ${d1.score}）`);
});

check("内容型降权：纯联名日不得进「值得去」", () => {
  const d = scoreDay({
    date: "2026-10-11",
    events: [
      { eventType: 4, articleDto: { title: "麦当劳 X PEACEMINUSONE" } },
      { eventType: 4, articleDto: { title: "限定周边即将开售" } },
    ],
  });
  ok(d.level.key !== "good" && d.level.key !== "great", `纯联名不应达「值得去」，实际 ${d.level.label}(${d.score})`);
});

check("加价换购不双重计分（明确标价让位）", () => {
  const d = scoreDay({
    date: "2026-10-11",
    events: [
      { eventType: 4, articleDto: { title: "限定周边开售", content: "任意餐品消费加 39.9 元即可得" } },
    ],
  });
  // 只应按"加价换购(8)"计，不应再叠加"明确标价(22)"
  ok(!d.reasons.some((r) => /明确标价/.test(r)), "不应命中明确标价");
  ok(d.reasons.some((r) => /加价换购/.test(r)), "应命中加价换购");
});

check("裸「专属」不再虚增会员分", () => {
  const d = scoreDay({
    date: "2026-10-11",
    events: [{ eventType: 4, articleDto: { title: "APP专享积分抢先购" } }],
  });
  ok(!d.reasons.some((r) => /会员专属/.test(r)), "裸『专享/专属』不应算会员价");
});

check("scoreCalendar：upcoming 含今天及未来，不含往期", () => {
  const today = todayStr();
  const cal = {
    dailyList: [
      { date: addDays(today, -2), dateText: `${today} 往期回顾`, events: [{ eventType: 4, articleDto: { title: "上周超值9.9元" } }] },
      { date: today, today: true, events: [{ eventType: 4, articleDto: { title: "今日超值9.9元" } }] },
      { date: addDays(today, 1), today: false, events: [{ eventType: 4, articleDto: { title: "明日免单" } }] },
    ],
  };
  const r = scoreCalendar(cal);
  ok(r.today, "应识别今天");
  ok(r.upcoming.some((d) => d.date === today), "upcoming 应含今天");
  ok(r.upcoming.some((d) => d.date === addDays(today, 1)), "upcoming 应含明天");
  ok(!r.upcoming.some((d) => d.isPast), "upcoming 不应含往期");
  ok(r.past.length === 1, `应识别 1 个往期日，实际 ${r.past.length}`);
  ok(r.past[0].isPast === true, "往期日应标记 isPast");
});

check("往期日不进入 best/bestOverall", () => {
  const today = todayStr();
  const cal = {
    dailyList: [
      // 往期有个超级大活动，但已结束，不该被推荐
      { date: addDays(today, -3), dateText: `${today} 往期回顾`, events: [{ eventType: 4, articleDto: { title: "免费霸王餐免单" } }] },
      { date: addDays(today, 1), events: [{ eventType: 4, articleDto: { title: "9.9元早餐" } }] },
    ],
  };
  const r = scoreCalendar(cal);
  ok(!r.best || !r.best.isPast, "best 不应是往期日");
  ok(!r.bestOverall || !r.bestOverall.isPast, "bestOverall 不应是往期日");
});

check("isPastDay 识别多种往期文案", () => {
  ok(isPastDay({ dateText: "2026年10月7日 往期回顾" }) === true, "往期回顾应判为往期");
  ok(isPastDay({ dateText: "2026年10月7日 已结束" }) === true, "已结束应判为往期");
  ok(isPastDay({ dateText: "2026年10月25日" }) === false, "普通日期不应判为往期");
});

check("推荐 floor：低分日不塞进 TOP", () => {
  const today = todayStr();
  const cal = {
    dailyList: [
      { date: addDays(today, 1), events: [{ eventType: 4, articleDto: { title: "9.9元早餐两件套" } }] },
      { date: addDays(today, 2), events: [] }, // 无活动日
    ],
  };
  const r = scoreCalendar(cal);
  ok(r.top.every((d) => d.score >= r.recommendFloor), "TOP 里不应有低于 floor 的日子");
  ok(!r.top.some((d) => d.eventCount === 0), "无活动日不应进 TOP");
});

check("力度 → 策略偏置（预算永不放宽）", () => {
  // 需求说明书 §13.2：预算为硬上限，任何活动力度都不得放大预算
  ok(!("budgetRelax" in levelToBias(levelOf(80))), "偏置对象不应再有 budgetRelax 字段");
  ok(levelToBias(levelOf(80)).prefTrend > 1, "大力日应提高尝鲜倾向（偏好权重，非预算）");
  eq(levelToBias(levelOf(10)).prefTrend < 1, true, "平淡日应降低尝鲜倾向");
});

// ── 热量与训练 ───────────────────────────────────
check("MET 消耗：跑步 60min 60kg", () => {
  const b = burnOf({ type: "run", minutes: 60, weightKg: 60 });
  eq(b.kcal, Math.round(8.5 * 60 * 1), "跑步消耗");
});
check("MET 消耗：静息为 0 分钟时", () => {
  eq(burnOf({ type: "run", minutes: 0, weightKg: 60 }).kcal, 0);
});
check("计划消耗求和", () => {
  const r = burnOfPlan([
    { type: "run", minutes: 30, weightKg: 60 },
    { type: "yoga", minutes: 30, weightKg: 60 },
  ]);
  ok(r.total > 0 && r.items.length === 2, "应有 2 项且总和 > 0");
});

check("BMR 公式（女性）", () => {
  const v = bmr({ gender: "female", weightKg: 55, heightCm: 163, age: 30 });
  eq(v, Math.round(10 * 55 + 6.25 * 163 - 5 * 30 - 161));
});
check("男性 BMR 高于女性同参数", () => {
  const p = { weightKg: 60, heightCm: 170, age: 30 };
  ok(bmr({ ...p, gender: "male" }) > bmr({ ...p, gender: "female" }), "男性应更高");
});
check("TDEE 与活动系数成正比", () => {
  const p = { gender: "female", weightKg: 55, heightCm: 163, age: 30 };
  ok(tdee({ ...p, activityFactor: 1.725 }) > tdee({ ...p, activityFactor: 1.2 }), "高活动应更高");
});

check("热量收支：盈余", () => {
  const r = balance({ intakeKcal: 500, burnKcal: 0, targetKcal: 1800 });
  eq(r.verdict, "surplus");
});
check("热量收支：平衡", () => {
  const r = balance({ intakeKcal: 1780, burnKcal: 0, targetKcal: 1800 });
  eq(r.verdict, "balanced");
});
check("热量收支：超标", () => {
  const r = balance({ intakeKcal: 2500, burnKcal: 0, targetKcal: 1800 });
  eq(r.verdict, "over");
});
check("热量收支：训练消耗抵扣", () => {
  const noBurn = balance({ intakeKcal: 1800, burnKcal: 0, targetKcal: 1800 });
  const withBurn = balance({ intakeKcal: 1800, burnKcal: 400, targetKcal: 1800 });
  ok(withBurn.netKcal < noBurn.netKcal, "消耗应降低净摄入");
  eq(withBurn.verdict, "surplus", "抵扣后应由平衡转盈余");
});

check("热量评分：过低热量扣分（不能越轻越好）", () => {
  const low = nutritionScore({ kcal: 88 }, { maxKcal: 1600 });
  const fit = nutritionScore({ kcal: 500 }, { maxKcal: 1600 });
  ok(fit.score > low.score, `500kcal(${fit.score}) 应优于 88kcal(${low.score})`);
});
check("热量评分：超目标扣分", () => {
  const s = nutritionScore({ kcal: 2000 }, { maxKcal: 1600 });
  ok(s.reasons.some((r) => r.includes("超出")), "应提示超出");
});
check("热量评分：蛋白质达标加分", () => {
  const s = nutritionScore({ kcal: 500, protein: 25 }, { maxKcal: 1600, minProtein: 20 });
  ok(s.reasons.some((r) => r.includes("达标")), "应提示达标");
});
check("热量评分：null 输入安全", () => {
  eq(nutritionScore(null, {}).score, 0);
});

check("训练模板展开：减脂 4 项/周", () => {
  const plan = expandPlan(TRAINING_TEMPLATES.fatLoss, "2026-10-05", "2026-10-11"); // 周一到周日
  eq(plan.length, 4, "减脂模板每周 4 次");
});
check("训练模板展开：增肌 4 次", () => {
  const plan = expandPlan(TRAINING_TEMPLATES.muscle, "2026-10-05", "2026-10-11");
  eq(plan.length, 4);
});
check("训练模板展开：跨两周翻倍", () => {
  const plan = expandPlan(TRAINING_TEMPLATES.maintain, "2026-10-05", "2026-10-18");
  eq(plan.length, 6, "维持模板两周 6 次");
});
check("训练模板展开：非法日期返回空", () => {
  eq(expandPlan(TRAINING_TEMPLATES.fatLoss, "bad", "worse").length, 0);
});

// ── ICS 规范 ─────────────────────────────────────
check("ICS 转义：逗号分号反斜杠换行", () => {
  const s = escapeText("a,b;c\\d\ne");
  eq(s, "a\\,b\\;c\\\\d\\ne");
});
check("ICS 折行：长行被折叠", () => {
  const long = "SUMMARY:" + "啊".repeat(60);
  const folded = foldLine(long);
  ok(folded.includes("\r\n "), "应含 CRLF+空格续行");
  for (const l of folded.split("\r\n")) {
    ok(Buffer.from(l, "utf8").length <= 75, `折行后每行应 ≤75 字节，实际 ${Buffer.from(l, "utf8").length}`);
  }
});
check("ICS 折行：短行不变", () => {
  eq(foldLine("SUMMARY:短"), "SUMMARY:短");
});
check("ICS 结构完整", () => {
  const ics = buildIcs(
    [{ uid: "u1", summary: "测试", start: new Date(2026, 9, 10, 12, 0), minutes: 30, alarmMinutes: 15 }],
    { calendarName: "测试日历" }
  );
  ok(ics.startsWith("BEGIN:VCALENDAR\r\n"), "应以 VCALENDAR 开头");
  ok(ics.trim().endsWith("END:VCALENDAR"), "应以 END:VCALENDAR 结尾");
  eq((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  eq((ics.match(/END:VEVENT/g) || []).length, 1);
  ok(ics.includes("BEGIN:VALARM"), "应含提醒");
  ok(ics.includes("TZID:Asia/Shanghai"), "应含时区定义");
});
check("ICS 多事件配对", () => {
  const events = Array.from({ length: 5 }, (_, i) => ({
    uid: `u${i}`,
    summary: `事件${i}`,
    start: new Date(2026, 9, 10 + i, 12, 0),
  }));
  const ics = buildIcs(events);
  eq((ics.match(/BEGIN:VEVENT/g) || []).length, 5);
  eq((ics.match(/END:VEVENT/g) || []).length, 5);
});
check("scheduleToIcs：从日程生成", () => {
  const ics = scheduleToIcs([
    { date: "2026-10-10", time: "11:30", kind: "meal", title: "午饭" },
    { date: "2026-10-10", time: "19:30", kind: "training", title: "跑步" },
  ]);
  eq((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  ok(ics.includes("午饭") && ics.includes("跑步"), "标题应保留");
});

// ── UID 稳定性（需求说明书 §8 / AC-29、AC-34）──────
check("UID 不含列表序号：重排后同一事件 UID 不变", () => {
  const a = toEvent({ date: "2026-10-10", time: "11:30", kind: "meal", title: "午饭", slot: "lunch" });
  // 模拟列表顺序变化后重新生成（旧的 idx 方案会得到不同 UID）
  const b = toEvent({ date: "2026-10-10", time: "11:30", kind: "meal", title: "午饭", slot: "lunch" });
  eq(a.uid, b.uid, "同一业务事件 UID 必须稳定");
  ok(!/-\d+@/.test(a.uid.replace(/@.*/, "") + "@") || !/\b0\b/.test(a.uid), "UID 不应含列表序号");
});

check("UID 稳定标识构成：scope-planId-date-slot-type", () => {
  const uid = buildUid({
    userScope: "local",
    planId: "default",
    date: "2026-10-10",
    slot: "lunch",
    type: "meal",
  });
  eq(uid, "local-default-2026-10-10-lunch-meal@maimen.local");
});

check("同日早餐与晚餐 UID 不同（AC-34）", () => {
  const b = toEvent({ date: "2026-10-10", time: "07:30", kind: "meal", title: "早餐", slot: "breakfast" });
  const d = toEvent({ date: "2026-10-10", time: "18:30", kind: "meal", title: "晚餐", slot: "dinner" });
  ok(b.uid !== d.uid, "同一天不同餐次必须能共存");
});

check("同一餐次的提醒与事件 UID 不同", () => {
  const meal = toEvent({ date: "2026-10-10", kind: "meal", title: "午饭", slot: "lunch", type: "meal" });
  const rem = buildUid({ date: "2026-10-10", slot: "lunch", type: "reminder" });
  ok(meal.uid !== rem, "事件与提醒不得共用 UID");
});

check("UID 含非法字符时被净化", () => {
  const uid = buildUid({ date: "2026-10-10", slot: "lunch 午餐/正餐", type: "meal" });
  ok(!/[\s/]/.test(uid), "UID 不应含空格或斜杠");
});

check("VEVENT 含 SEQUENCE 与 LAST-MODIFIED（更新可识别）", () => {
  const ics = buildIcs([
    { uid: "u-seq", summary: "改过的午饭", start: new Date(2026, 9, 10, 12, 0), sequence: 2 },
  ]);
  ok(ics.includes("SEQUENCE:2"), "应输出 SEQUENCE");
  ok(ics.includes("LAST-MODIFIED:"), "应输出 LAST-MODIFIED");
  ok(ics.includes("DTSTAMP:"), "应输出 DTSTAMP");
});

check("PRODID 使用 maimen 前缀", () => {
  const ics = buildIcs([{ uid: "u1", summary: "x", start: new Date(2026, 9, 10, 12, 0) }]);
  ok(ics.includes("-//maimen-calendar//"), "PRODID 应为 maimen-calendar");
});

// ── 结果 ─────────────────────────────────────────
console.log(`\n${failed.length === 0 ? "✅" : "❌"} 通过 ${pass}/${pass + failed.length}`);
if (failed.length) {
  console.log("\n失败项：");
  for (const f of failed) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("PASS: 城市码 / 天气分层 / 力度评分 / 内容型不误判 / 券加成 / 热量收支 / 训练展开 / ICS 规范");
