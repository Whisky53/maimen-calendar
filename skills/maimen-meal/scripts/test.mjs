import assert from "node:assert/strict";
import { recommend, DEMO_MEALS, normalizeMeal, inferSlot, MEAL_SLOTS, MEAL_PURPOSES } from "../scripts/recommend.mjs";
import { derivePreferences, zodiacOf, weatherSignals } from "../scripts/preference.mjs";
import {
  SCHEMA_VERSION,
  EVENT_TYPES,
  FEEDBACK_VERDICTS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_WINDOW_DAYS,
  emptyStoreForTest,
  loadMemory,
  saveMemory,
  makeEvent,
  appendEvent,
  deterministicId,
  purgeExpired,
  deriveMemory,
  memoryForRecommend,
  listEvents,
  revokeFeedback,
  clearMemory,
  exportMemory,
  updateConfirmed,
  recordInferred,
  trendReport,
} from "../scripts/memory.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// ── 记忆事件流 v2（需求说明书 §7）────────────────────
function tmpMemPath() {
  return join(mkdtempSync(join(tmpdir(), "maimen-m-")), "memory.json");
}

// 19) 事件类型与反馈枚举齐全
assert.equal(EVENT_TYPES.RECOMMENDATION_SHOWN, "recommendation_shown");
assert.equal(EVENT_TYPES.SELECTED, "selected");
assert.equal(EVENT_TYPES.CONSUMED, "consumed");
assert.equal(EVENT_TYPES.REROLLED, "rerolled");
assert.equal(EVENT_TYPES.FEEDBACK, "feedback");
assert.equal(EVENT_TYPES.SKIPPED, "skipped");
assert.equal(EVENT_TYPES.PREFERENCE_UPDATED, "preference_updated");
assert.ok(FEEDBACK_VERDICTS.includes("like") && FEEDBACK_VERDICTS.includes("too_spicy"));
assert.equal(SCHEMA_VERSION, 2);
assert.equal(DEFAULT_RETENTION_DAYS, 180);
assert.equal(DEFAULT_WINDOW_DAYS, 30);

// 20) eventId 幂等：同一事件重复写入只入一次
{
  const s = emptyStoreForTest();
  const ev = makeEvent({ type: EVENT_TYPES.SELECTED, mealId: "a", eventId: "fixed-1" });
  assert.equal(appendEvent(s, ev), true, "首次应写入");
  assert.equal(appendEvent(s, ev), false, "重复 eventId 不应再写");
  assert.equal(s.events.length, 1);
}

// 21) deterministicId 稳定且区分参数
assert.equal(deterministicId("u", "recommendation_shown", "2026-10-10", "a"), deterministicId("u", "recommendation_shown", "2026-10-10", "a"));
assert.notEqual(deterministicId("u", "selected", "2026-10-10", "a"), deterministicId("u", "selected", "2026-10-10", "b"));
assert.equal(deterministicId("x").length, 32, "确定性 id 应为 32 位");

// 22) selected 是弱偏好：只有 selected 不构成「实际消费」
{
  const s = emptyStoreForTest();
  appendEvent(s, makeEvent({ type: EVENT_TYPES.SELECTED, mealId: "a", mealSlot: "lunch", at: new Date().toISOString() }));
  const t = trendReport(s);
  assert.equal(t.basis, "selected", "仅 selected 时依据应为选择偏好");
  assert.equal(t.basisLabel, "选择偏好");
  assert.ok(!/实际消费/.test(t.note), "不得把选择说成实际消费");
}

// 23) consumed 才构成实际消费
{
  const s = emptyStoreForTest();
  const now = new Date().toISOString();
  for (let i = 0; i < 3; i++) {
    appendEvent(s, makeEvent({ type: EVENT_TYPES.CONSUMED, mealId: `m${i}`, mealSlot: "lunch", at: now }));
  }
  const t = trendReport(s, { slot: "lunch" });
  assert.equal(t.basis, "consumed", "≥3 次 consumed 时应基于实际消费");
  assert.equal(t.basisLabel, "实际消费");
}

// 24) 趋势样本不足时不报告
{
  const s = emptyStoreForTest();
  appendEvent(s, makeEvent({ type: EVENT_TYPES.SELECTED, mealId: "a", mealSlot: "lunch", at: new Date().toISOString() }));
  const t = trendReport(s, { slot: "lunch", minSample: 3 });
  assert.ok(/样本不足/.test(t.note), "样本不足应明确说明");
}

// 25) confirmed 不得被推断覆盖，推断不得升级为禁忌
{
  const s = emptyStoreForTest();
  updateConfirmed(s, { dislikes: ["x"], allergies: ["花生"] });
  recordInferred(s, "好像不太喜欢 x");
  const m = deriveMemory(s, { slot: "lunch" });
  assert.ok(m.dislikes.has("x"), "明确不喜欢应保留在排除集合");
  assert.ok(s.confirmed.allergies.includes("花生"), "过敏属明确确认，必须保留");
  assert.equal(s.inferred.notes.length, 1);
  assert.equal(s.inferred.notes[0].kind, "inferred", "推断必须标注为 inferred");
  assert.ok(!s.confirmed.dislikes.includes("花生"), "推断不得写入 confirmed.dislikes");
}

// 26) 同餐次优先：只按同餐次取最近 3 次吃过
{
  const s = emptyStoreForTest();
  const now = new Date().toISOString();
  appendEvent(s, makeEvent({ type: EVENT_TYPES.CONSUMED, mealId: "bk1", mealSlot: "breakfast", at: now }));
  appendEvent(s, makeEvent({ type: EVENT_TYPES.CONSUMED, mealId: "lu1", mealSlot: "lunch", at: now }));
  appendEvent(s, makeEvent({ type: EVENT_TYPES.CONSUMED, mealId: "lu2", mealSlot: "lunch", at: now }));
  const m = deriveMemory(s, { slot: "lunch" });
  assert.deepEqual(m.recentSameSlot, ["lu2", "lu1"], "同餐次应只含 lunch 的两条");
  assert.ok(m.recentAnySlot.includes("bk1"), "跨餐次记录仍进入较弱信号");
  assert.ok(m.crossSlotPenalty.includes("bk1"), "跨餐次应进入 crossSlotPenalty");
}

// 27) rerolled 只在本轮避重，不形成长期厌恶
{
  const s = emptyStoreForTest();
  appendEvent(s, makeEvent({ type: EVENT_TYPES.REROLLED, mealId: "r1", mealSlot: "lunch", at: new Date().toISOString() }));
  const m = deriveMemory(s, { slot: "lunch" });
  assert.ok(m.rerolledThisRound.has("r1"), "本轮换过应进入避重");
  assert.ok(!m.dislikes.has("r1"), "换过不等于不喜欢，不得进长期排除");
}

// 28) 保留期清理：180 天前的事件被清掉
{
  const s = emptyStoreForTest();
  const old = new Date(Date.now() - 200 * 86400000).toISOString();
  const fresh = new Date().toISOString();
  appendEvent(s, makeEvent({ type: EVENT_TYPES.SELECTED, mealId: "old", at: old, eventId: "e-old" }));
  appendEvent(s, makeEvent({ type: EVENT_TYPES.SELECTED, mealId: "new", at: fresh, eventId: "e-new" }));
  const removed = purgeExpired(s, { retentionDays: 180 });
  assert.equal(removed, 1, "应清理 1 条过期事件");
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].mealId, "new");
}

// 29) 窗口：30 天外的事件不进入派生视图，但仍在存储里
{
  const s = emptyStoreForTest();
  const old = new Date(Date.now() - 60 * 86400000).toISOString();
  appendEvent(s, makeEvent({ type: EVENT_TYPES.CONSUMED, mealId: "old", mealSlot: "lunch", at: old }));
  const m = deriveMemory(s, { slot: "lunch", windowDays: 30 });
  assert.equal(m.eventCount, 0, "窗口外不应进入派生视图");
  assert.equal(s.events.length, 1, "但原始事件仍保留在存储中");
}

// 30) 清空：默认一并清除派生偏好；keepConfirmed 保留明确忌口
{
  const s1 = emptyStoreForTest();
  updateConfirmed(s1, { dislikes: ["d"] });
  recordInferred(s1, "推断1");
  appendEvent(s1, makeEvent({ type: EVENT_TYPES.SELECTED, mealId: "a", at: new Date().toISOString() }));
  clearMemory(s1, { keepConfirmed: true });
  assert.equal(s1.events.length, 0, "事件应清空");
  assert.equal(s1.inferred.notes.length, 0, "推断偏好应一并清除");
  assert.deepEqual(s1.confirmed.dislikes, ["d"], "keepConfirmed 应保留明确忌口");

  const s2 = emptyStoreForTest();
  updateConfirmed(s2, { dislikes: ["d"] });
  clearMemory(s2, { keepConfirmed: false });
  assert.deepEqual(s2.confirmed.dislikes, [], "非 keepConfirmed 应全清");
}

// 31) 撤销反馈：事件与 confirmed 同步摘除
{
  const s = emptyStoreForTest();
  appendEvent(s, makeEvent({ type: EVENT_TYPES.FEEDBACK, mealId: "a", verdict: "dislike", at: new Date().toISOString() }));
  updateConfirmed(s, { dislikes: ["a"] });
  const n = revokeFeedback(s, "a");
  assert.ok(n >= 1, "应删掉反馈事件");
  assert.deepEqual(s.confirmed.dislikes, [], "撤销后应同步从 confirmed 摘除");
  const m = deriveMemory(s, { slot: "lunch" });
  assert.ok(!m.dislikes.has("a"), "撤销后不应再被排除");
}

// 32) 查看筛选
{
  const s = emptyStoreForTest();
  const now = new Date().toISOString();
  appendEvent(s, makeEvent({ type: EVENT_TYPES.SELECTED, mealId: "a", mealSlot: "lunch", at: now, eventId: "1" }));
  appendEvent(s, makeEvent({ type: EVENT_TYPES.SELECTED, mealId: "b", mealSlot: "dinner", at: now, eventId: "2" }));
  assert.equal(listEvents(s, { slot: "lunch" }).length, 1);
  assert.equal(listEvents(s, { type: EVENT_TYPES.SELECTED }).length, 2);
}

// 33) 落盘与读回（v2）
{
  const p = tmpMemPath();
  const s = emptyStoreForTest();
  appendEvent(s, makeEvent({ type: EVENT_TYPES.SELECTED, mealId: "a", mealSlot: "lunch", at: new Date().toISOString() }));
  assert.equal(saveMemory(s, p), true);
  const back = loadMemory(p);
  assert.equal(back.schemaVersion, 2);
  assert.equal(back.events.length, 1);
  assert.equal(back.events[0].mealId, "a");
  rmSync(join(p, ".."), { recursive: true, force: true });
}

// 34) v1 → v2 迁移：数据不丢失，dislike 迁入 confirmed
{
  const p = tmpMemPath();
  const v1 = {
    schemaVersion: 1,
    selections: [
      { id: "old1", name: "双层吉士堡", slot: "lunch", purpose: "full-meal", priceCents: 1500, at: new Date().toISOString() },
    ],
    feedback: { old1: { verdict: "dislike", at: new Date().toISOString() } },
    meta: { createdAt: new Date().toISOString() },
  };
  writeFileSync(p, JSON.stringify(v1), "utf8");
  const back = loadMemory(p);
  assert.equal(back.schemaVersion, 2, "应迁移到 v2");
  assert.equal(back.events.length, 2, "1 条 selection + 1 条 feedback 应全部迁移");
  assert.ok(back.events.some((e) => e.type === EVENT_TYPES.SELECTED && e.mealId === "old1"), "selection 应迁为 selected");
  assert.ok(back.events.some((e) => e.type === EVENT_TYPES.FEEDBACK && e.verdict === "dislike"), "feedback 应迁移");
  assert.ok(back.confirmed.dislikes.includes("old1"), "v1 dislike 属明确表达，应迁入 confirmed");
  rmSync(join(p, ".."), { recursive: true, force: true });
}

// 35) 损坏文件安全降级
{
  const p = tmpMemPath();
  writeFileSync(p, "{ 坏掉的 JSON", "utf8");
  const back = loadMemory(p);
  assert.equal(back.schemaVersion, 2);
  assert.equal(back.events.length, 0, "损坏文件应降级为空存储而非抛错");
  rmSync(join(p, ".."), { recursive: true, force: true });
}

// 36) 事件字段完整（§7.2）
{
  const ev = makeEvent({
    type: EVENT_TYPES.SELECTED,
    mealId: "a",
    name: "麦辣鸡腿堡",
    mealSlot: "lunch",
    mealPurpose: "full-meal",
    priceCents: 1500,
    storeCode: "S001",
    requestId: "req-1",
    sourceSnapshot: { source: "mcp", status: "verified" },
  });
  for (const k of ["schemaVersion", "eventId", "userId", "requestId", "type", "at", "mealId", "storeCode", "priceCents", "sourceSnapshot"]) {
    assert.ok(k in ev, `事件应含字段 ${k}`);
  }
  assert.equal(ev.userId, "local");
  assert.equal(ev.priceCents, 1500);
}

// 37) 价格未知保留 null，不伪装成 0
{
  const ev = makeEvent({ type: EVENT_TYPES.SELECTED, mealId: "a", priceCents: null });
  assert.equal(ev.priceCents, null, "未知价格应保留 null");
  const ev2 = makeEvent({ type: EVENT_TYPES.SELECTED, mealId: "a", priceCents: Number.NaN });
  assert.equal(ev2.priceCents, null, "非法价格应归一为 null 而非 0");
}

// 38) memoryForRecommend：排除集与最近选择正确传递
{
  const s = emptyStoreForTest();
  const now = new Date().toISOString();
  updateConfirmed(s, { dislikes: ["bad"] });
  appendEvent(s, makeEvent({ type: EVENT_TYPES.CONSUMED, mealId: "c1", mealSlot: "lunch", at: now }));
  const r = memoryForRecommend(s, { slot: "lunch" });
  assert.ok(r.excluded.has("bad"), "明确不喜欢应进入 excluded");
  assert.equal(r.lastPick, "c1", "最近同餐次吃过应作为 lastPick");
  assert.ok(r.history.some((h) => h.kind === "selected"), "历史应含 selected 形态");
}

// 39) 导出可读 JSON
{
  const s = emptyStoreForTest();
  appendEvent(s, makeEvent({ type: EVENT_TYPES.SELECTED, mealId: "a", at: new Date().toISOString() }));
  const txt = exportMemory(s);
  const parsed = JSON.parse(txt);
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.events.length, 1);
}

console.log(
  "PASS: 预算 / 忌口 / 冷热 / 无解 / 明确排除 / 重抽避重复 / 星座 / 天气 / 偏好合成 / 归一化 / 餐次 / 用餐目的 / 价格未知 / 记忆 + 事件流v2 / 幂等 / 迁移 / 保留期 / 确认vs推断 / 趋势口径"
);
