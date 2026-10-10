import assert from "node:assert/strict";
import { recommend, DEMO_MEALS, normalizeMeal } from "../scripts/recommend.mjs";
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

console.log("PASS: 预算 / 忌口 / 冷热 / 无解 / 明确排除 / 重抽避重复 / 星座 / 天气 / 偏好合成 / 归一化");
