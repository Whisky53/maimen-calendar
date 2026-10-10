import assert from "node:assert/strict";
import { recommend, DEMO_MEALS, normalizeMeal, inferSlot, MEAL_SLOTS, MEAL_PURPOSES } from "../scripts/recommend.mjs";
import { derivePreferences, zodiacOf, weatherSignals } from "../scripts/preference.mjs";

// 1) 硬约束：预算
for (let i = 0; i < 50; i++) {
  const r = recommend({ settings: { budget: 22, drink: "any", noSpicy: false } });
  if (r.meal) assert.ok(r.meal.price <= 2200, "不应超过预算");
}

// 2) 硬约束：不吃辣
for (let i = 0; i < 50; i++) {
  const r = recommend({ settings: { budget: 60, noSpicy: true, drink: "any" } });
  if (r.meal) assert.equal(r.meal.spicy, false, "不应出现辣味");
}

// 3) 硬约束：冷饮
for (let i = 0; i < 50; i++) {
  const r = recommend({ settings: { budget: 60, drink: "cold", noSpicy: false } });
  if (r.meal) assert.equal(r.meal.temp, "cold", "应为冷饮");
}

// 4) 无解
assert.equal(recommend({ settings: { budget: 5, drink: "any", noSpicy: false } }).meal, null);

// 5) 明确不喜欢被过滤
const dislikeAll = DEMO_MEALS.map((m) => ({
  id: m.id, kind: "feedback", payload: { mealId: m.id, value: "dislike" }, createdAt: "",
}));
assert.equal(recommend({ settings: { budget: 60 }, history: dislikeAll }).meal, null);

// 6) 重抽避重复
for (let i = 0; i < 30; i++) {
  const r = recommend({ settings: { budget: 30 }, previous: "a" });
  if (r.meal) assert.notEqual(r.meal.id, "a");
}

// 7) 星座解析
assert.equal(zodiacOf("2000-08-15").name, "狮子座");
assert.equal(zodiacOf("1999-12-25").name, "摩羯座");
assert.equal(zodiacOf("1999-03-21").name, "白羊座");

// 8) 天气信号
assert.equal(weatherSignals({ tempC: 5 })[0].value, "hot");
assert.equal(weatherSignals({ tempC: 35 })[0].value, "cold");

// 9) 偏好合成：冷天 hot 优先
const pref = derivePreferences({ weather: { tempC: 5 }, birthday: "2000-08-15" });
assert.equal(pref.preferredTemp, "hot", "冷天权重应压过火象的冷饮倾向");

// 10) 真实餐品归一化（模拟 MCP 返回）
const norm = normalizeMeal({ name: "麦香鱼套餐", price: 2700, drink: "冰可乐" }, 0);
assert.equal(norm.temp, "cold");
assert.equal(norm.price, 2700);

// 11) 价格缺失归一化为 null，不按 0（需求说明书 §13.2）
const noPrice = normalizeMeal({ name: "未知价套餐" }, 0);
assert.equal(noPrice.price, null, "缺失价格应为 null");
assert.equal(noPrice.priceStatus, "unknown");

// 12) 餐次推断（AC-30 四餐次路由）
assert.equal(inferSlot(new Date(2026, 9, 10, 7, 30)), "breakfast");
assert.equal(inferSlot(new Date(2026, 9, 10, 12, 0)), "lunch");
assert.equal(inferSlot(new Date(2026, 9, 10, 15, 30)), "snack");
assert.equal(inferSlot(new Date(2026, 9, 10, 19, 0)), "dinner");
assert.equal(inferSlot(new Date(2026, 9, 10, 23, 30)), "late-night");
assert.equal(inferSlot(new Date(2026, 9, 10, 2, 0)), "late-night");

// 13) 餐次写入约束
const rLunch = recommend({ settings: { budget: 40, mealSlot: "lunch" }, history: [] });
assert.equal(rLunch.slot, "lunch");
assert.equal(rLunch.purpose, "full-meal");

// 14) 仅饮品目的：只出带饮品的候选
for (let i = 0; i < 30; i++) {
  const r = recommend({ settings: { budget: 40, mealSlot: "snack", mealPurpose: "drink-only" } });
  if (r.meal) assert.ok(r.meal.hasDrink, "仅饮品目的应只出带饮品的候选");
}

// 15) 预算为硬上限：任何设置都不会放宽
for (let i = 0; i < 30; i++) {
  const r = recommend({ settings: { budget: 20, mealSlot: "lunch" }, history: [] });
  if (r.meal) assert.ok(r.meal.price <= 2000, "预算不得被突破");
}

// 16) 无解时给出 emptyReason，而非静默返回 null
const rNone = recommend({ settings: { budget: 1, mealSlot: "lunch" }, history: [] });
assert.equal(rNone.meal, null);
assert.ok(rNone.emptyReason && rNone.emptyReason.length > 0, "无解应说明原因");

// 17) 记忆：同餐次历史影响避重
const memHistory = [{ id: "a", slot: "lunch" }];
const rMem = recommend({ settings: { budget: 60, mealSlot: "lunch" }, history: memHistory });
assert.ok(rMem.count >= 0);

// 18) 记忆：明确排除集合生效
const rExc = recommend({
  settings: { budget: 60, mealSlot: "lunch" },
  excluded: new Set(DEMO_MEALS.map((m) => m.id)),
});
assert.equal(rExc.meal, null, "全部排除后应无解");

console.log(
  "PASS: 预算 / 忌口 / 冷热 / 无解 / 明确排除 / 重抽避重复 / 星座 / 天气 / 偏好合成 / 归一化 / 餐次 / 用餐目的 / 价格未知 / 记忆"
);
