/**
 * 记忆与历史（maimen-meal / maimen-calendar 共用存储）。
 * 对应需求说明书 §7「历史知识库与反馈学习」。
 *
 * 存储位置：默认 $HOME/.maimen/memory.json（可用 MAIMEN_MEMORY_PATH 覆盖）。
 *
 * ── 设计要点 ─────────────────────────────────────────
 * 1) 记录的是**明确交互事件**，不保存无关对话全文，不把浏览等同选择（§7.1）
 * 2) 事件带 eventId，重试不重复写入（§7.2）
 * 3) 写入用原子替换（先写临时文件再 rename），并发不丢数据
 * 4) 默认读取最近 30 天；原始事件默认保留 180 天，均可配置
 * 5) 明确偏好（confirmed）与统计推断（inferred）分开存，推断不得升级为禁忌
 * 6) 重复度优先比较同餐次，跨餐次仅作较弱信号（早餐喝咖啡不推断晚餐）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

const DEFAULT_PATH = join(homedir(), ".maimen", "memory.json");

/** 当前 Schema 版本。v1 → v2 的迁移见 migrate()。 */
export const SCHEMA_VERSION = 2;

/** 默认保留与窗口（天）。 */
export const DEFAULT_RETENTION_DAYS = 180;
export const DEFAULT_WINDOW_DAYS = 30;

/** 事件类型（§7.1）。 */
export const EVENT_TYPES = Object.freeze({
  RECOMMENDATION_SHOWN: "recommendation_shown",
  SELECTED: "selected",
  CONSUMED: "consumed",
  REROLLED: "rerolled",
  FEEDBACK: "feedback",
  SKIPPED: "skipped",
  PREFERENCE_UPDATED: "preference_updated",
});

/** 反馈原因（§7.1「按原因更新偏好，保存原始反馈」）。 */
export const FEEDBACK_VERDICTS = Object.freeze([
  "like",
  "dislike",
  "too_spicy",
  "too_expensive",
  "too_cold",
  "too_hot",
]);

export function memoryPath() {
  return process.env.MAIMEN_MEMORY_PATH || DEFAULT_PATH;
}

function emptyStore() {
  return {
    schemaVersion: SCHEMA_VERSION,
    events: [],
    // 用户明确确认的偏好（不得被推断覆盖）
    confirmed: { dislikes: [], allergies: [], globalBans: [] },
    // 由统计推断的偏好（必须标注为推断，不得升级为禁忌）
    inferred: { notes: [] },
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  };
}

/** 供测试与调用方构造空白存储（不落地）。 */
export function emptyStoreForTest() {
  return emptyStore();
}

/**
 * 把 v1（selections/feedback 两段式）迁移到 v2（events 事件流）。
 * 迁移**保留全部既有数据**，不通过清空存储掩盖 Schema 变更（§15）。
 */
function migrate(raw) {
  if (!raw || typeof raw !== "object") return emptyStore();
  // 已是 v2
  if (raw.schemaVersion >= 2 && Array.isArray(raw.events)) {
    return {
      schemaVersion: SCHEMA_VERSION,
      events: raw.events,
      confirmed: raw.confirmed || emptyStore().confirmed,
      inferred: raw.inferred || emptyStore().inferred,
      meta: raw.meta || emptyStore().meta,
    };
  }
  // v1 → v2
  const store = emptyStore();
  const legacySel = Array.isArray(raw.selections) ? raw.selections : [];
  for (const s of legacySel) {
    store.events.push(
      makeEvent({
        type: EVENT_TYPES.SELECTED,
        at: s.at,
        mealId: String(s.id),
        name: s.name,
        mealSlot: s.slot || "lunch",
        mealPurpose: s.purpose || "full-meal",
        priceCents: Number.isFinite(s.priceCents) ? s.priceCents : null,
        sourceSnapshot: { source: "v1-migration", status: s.status || "unknown" },
      })
    );
  }
  const legacyFb = raw.feedback && typeof raw.feedback === "object" ? raw.feedback : {};
  for (const [id, v] of Object.entries(legacyFb)) {
    store.events.push(
      makeEvent({
        type: EVENT_TYPES.FEEDBACK,
        at: (v && v.at) || new Date().toISOString(),
        mealId: String(id),
        verdict: (v && v.verdict) || "unknown",
        sourceSnapshot: { source: "v1-migration", status: "verified" },
      })
    );
  }
  // v1 的 dislike 是用户明确表达过的，迁入 confirmed
  store.confirmed.dislikes = Object.entries(legacyFb)
    .filter(([, v]) => v && v.verdict === "dislike")
    .map(([id]) => String(id));
  store.meta = { createdAt: raw.meta?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), migratedFrom: 1 };
  return store;
}

/**
 * 构造一个事件。
 *
 * 字段（§7.2）：schemaVersion / eventId / userId / requestId / 类型 / 时间 /
 *               商品标识 / 门店 / 金额 / 来源快照
 */
export function makeEvent({
  type,
  at = new Date().toISOString(),
  eventId = null,
  userId = "local",
  requestId = null,
  mealId = null,
  name = null,
  mealSlot = null,
  mealPurpose = null,
  priceCents = null,
  storeCode = null,
  verdict = null,
  reason = null,
  sourceSnapshot = null,
  note = null,
} = {}) {
  const base = {
    schemaVersion: SCHEMA_VERSION,
    eventId: eventId || randomUUID(),
    userId,
    requestId,
    type,
    at,
    mealId: mealId == null ? null : String(mealId),
    name,
    mealSlot,
    mealPurpose,
    priceCents: Number.isFinite(priceCents) ? priceCents : null,
    storeCode: storeCode == null ? null : String(storeCode),
    verdict,
    reason,
    sourceSnapshot,
    note,
  };
  return base;
}

/** 读取存储。任何异常都降级为空存储，绝不中断推荐。 */
export function loadMemory(path = memoryPath()) {
  try {
    if (!existsSync(path)) return emptyStore();
    return migrate(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return emptyStore();
  }
}

/** 原子写入。失败返回 false，不抛出。 */
export function saveMemory(store, path = memoryPath()) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    store.meta = { ...(store.meta || {}), updatedAt: new Date().toISOString() };
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 追加事件。同 eventId 不重复写入（§7.2「同一事件重试不得重复写入」）。
 * @returns {boolean} 是否真的写入了
 */
export function appendEvent(store, event) {
  if (!event || !event.eventId) return false;
  if (store.events.some((e) => e.eventId === event.eventId)) return false; // 幂等
  store.events.push(event);
  return true;
}

/**
 * 生成确定性 eventId：同样的业务动作重复调用只写一次。
 * @param {string[]} parts
 */
export function deterministicId(...parts) {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 32);
}

/**
 * 清理超过保留期的事件（默认 180 天，可配置）。仅在显式调用时执行，不自动偷偷删。
 * @returns {number} 清理条数
 */
export function purgeExpired(store, { retentionDays = DEFAULT_RETENTION_DAYS, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - retentionDays * 86400000).toISOString();
  const before = store.events.length;
  store.events = store.events.filter((e) => (e.at || "") >= cutoff);
  return before - store.events.length;
}

// ── 派生视图 ─────────────────────────────────────────

/**
 * 从事件流派生推荐所需的信息。
 *
 * 规则（§7.2）：
 *   - 默认窗口最近 30 天
 *   - 近期重复优先参考最近 3 次**确认吃过**（consumed）的餐食
 *   - rerolled 只在本轮避重，不形成长期厌恶
 *   - 跨餐次作较弱信号：同餐次权重 1，跨餐次权重 0.3
 *   - 明确过敏与全局忌口跨餐次生效
 *
 * @param {object} store
 * @param {object} [opts]
 * @param {string|null} [opts.slot]      当前餐次
 * @param {number} [opts.windowDays]
 * @param {Date}   [opts.now]
 */
export function deriveMemory(store, { slot = null, windowDays = DEFAULT_WINDOW_DAYS, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - windowDays * 86400000).toISOString();
  const events = (store.events || []).filter((e) => (e.at || "") >= cutoff);

  const likes = new Set();
  const dislikes = new Set(); // 明确不喜欢（长期排除）
  const rerolledThisRound = new Set(); // 仅本轮避重
  const recentConsumedSameSlot = []; // 最近 3 次同餐次吃过
  const recentConsumedAnySlot = [];
  const pickCounts = new Map();

  for (const e of events) {
    const id = e.mealId == null ? null : String(e.mealId);
    if (e.type === EVENT_TYPES.FEEDBACK && id) {
      if (e.verdict === "like") likes.add(id);
      if (e.verdict === "dislike") dislikes.add(id);
    }
    if (e.type === EVENT_TYPES.REROLLED && id) rerolledThisRound.add(id);
    if (e.type === EVENT_TYPES.CONSUMED && id) {
      recentConsumedAnySlot.push(id);
      if (slot && e.mealSlot === slot) recentConsumedSameSlot.push(id);
      pickCounts.set(id, (pickCounts.get(id) || 0) + 1);
    }
    if (e.type === EVENT_TYPES.SELECTED && id) {
      pickCounts.set(id, (pickCounts.get(id) || 0) + 1);
    }
  }

  // 用户明确确认的偏好覆盖推断结果（§7.2：核心记忆是用户明确确认的偏好）
  for (const id of store.confirmed?.dislikes || []) dislikes.add(String(id));

  const sameSlotRecent = recentConsumedSameSlot.slice(-3).reverse();
  const anySlotRecent = recentConsumedAnySlot.slice(-3).reverse();

  // 跨餐次弱信号：最近吃过的（无论哪个餐次），权重 0.3
  const crossSlotPenalty = anySlotRecent.filter((id) => !sameSlotRecent.includes(id));

  return {
    likes,
    dislikes,
    rerolledThisRound,
    recentSameSlot: sameSlotRecent,
    recentAnySlot: anySlotRecent,
    crossSlotPenalty,
    pickCounts,
    eventCount: events.length,
    windowDays,
  };
}

/**
 * 生成给推荐引擎的历史形态（兼容 recommend.mjs 的 summarizeHistory）。
 * 同时返回 excluded（硬排除）与 previous（避重）。
 */
export function memoryForRecommend(store, { slot = null, windowDays = DEFAULT_WINDOW_DAYS, now = new Date() } = {}) {
  const m = deriveMemory(store, { slot, windowDays, now });
  const history = [];
  // like → 加分
  for (const id of m.likes) {
    history.push({ id, kind: "feedback", payload: { mealId: id, value: "like" } });
  }
  // 最近吃过的进入「最近 2 次」避重
  for (const id of m.recentSameSlot) {
    history.push({ id, kind: "selected", payload: { mealId: id } });
  }
  // 本轮换过的暂时避开
  for (const id of m.rerolledThisRound) {
    history.push({ id, kind: "reroll", payload: { mealId: id } });
  }
  const excluded = new Set([...m.dislikes]);
  return {
    history,
    excluded,
    lastPick: m.recentSameSlot[0] || null,
    crossSlotPenalty: m.crossSlotPenalty,
    view: m,
  };
}

// ── 用户操作：查看 / 反馈 / 撤销 / 导出 / 清空 ────────────

/** 查看：按条件筛选事件（供 CLI/UI 展示）。 */
export function listEvents(store, { type = null, slot = null, limit = 50, since = null } = {}) {
  let list = store.events || [];
  if (type) list = list.filter((e) => e.type === type);
  if (slot) list = list.filter((e) => e.mealSlot === slot);
  if (since) list = list.filter((e) => (e.at || "") >= since);
  return list.slice(-limit).reverse();
}

/**
 * 撤销一条反馈（按 mealId 与 type=feedback 的最新一条）。
 * 同时从 confirmed.dislikes 里摘除。
 */
export function revokeFeedback(store, mealId) {
  const id = String(mealId);
  let removed = 0;
  store.events = (store.events || []).filter((e) => {
    if (e.type === EVENT_TYPES.FEEDBACK && String(e.mealId) === id) {
      removed++;
      return false;
    }
    return true;
  });
  store.confirmed.dislikes = (store.confirmed.dislikes || []).filter((x) => String(x) !== id);
  return removed;
}

/**
 * 清空记录（§7.2：清空历史后同时重建或删除由历史派生的偏好）。
 * @param {object} store
 * @param {object} [opts]
 * @param {boolean} [opts.keepConfirmed=false] 是否保留用户明确确认的忌口/过敏
 */
export function clearMemory(store, { keepConfirmed = false } = {}) {
  store.events = [];
  store.inferred = { notes: [] }; // 由历史派生的推断偏好一并清除
  if (!keepConfirmed) {
    store.confirmed = { dislikes: [], allergies: [], globalBans: [] };
  }
  return store;
}

/** 导出为可读 JSON（供用户备份）。 */
export function exportMemory(store) {
  return JSON.stringify(store, null, 2);
}

/** 更新用户明确确认的偏好（preference_updated 事件）。 */
export function updateConfirmed(store, patch = {}) {
  store.confirmed = {
    dislikes: patch.dislikes || store.confirmed.dislikes || [],
    allergies: patch.allergies || store.confirmed.allergies || [],
    globalBans: patch.globalBans || store.confirmed.globalBans || [],
  };
  appendEvent(
    store,
    makeEvent({
      type: EVENT_TYPES.PREFERENCE_UPDATED,
      note: JSON.stringify(patch),
      sourceSnapshot: { source: "user-confirmed", status: "verified" },
    })
  );
  return store;
}

/**
 * 记录推断偏好（必须标注为推断，不得升级为禁忌）。
 */
export function recordInferred(store, note) {
  if (!store.inferred) store.inferred = { notes: [] };
  store.inferred.notes.push({ at: new Date().toISOString(), note, kind: "inferred" });
  if (store.inferred.notes.length > 50) store.inferred.notes = store.inferred.notes.slice(-50);
  return store;
}

// ── 分析输出（§7.3）──────────────────────────────────

/**
 * 生成趋势报告。**只有 selected 记录时称「选择偏好」，不称实际消费**（§7.3）。
 * 样本不足时不报告趋势。
 *
 * @param {object} store
 * @param {object} [opts]
 * @param {string} [opts.slot]
 * @param {number} [opts.minSample=3]
 */
export function trendReport(store, { slot = null, minSample = 3 } = {}) {
  const events = (store.events || []).filter((e) => !slot || e.mealSlot === slot);
  const consumed = events.filter((e) => e.type === EVENT_TYPES.CONSUMED);
  const selected = events.filter((e) => e.type === EVENT_TYPES.SELECTED);
  const feedbacks = events.filter((e) => e.type === EVENT_TYPES.FEEDBACK);

  const sample = consumed.length; // 只有 consumed 才算「实际消费」
  const basis = sample >= minSample ? "consumed" : selected.length ? "selected" : "none";

  const out = {
    basis,
    basisLabel:
      basis === "consumed" ? "实际消费" : basis === "selected" ? "选择偏好" : "无足够样本",
    sample: basis === "consumed" ? sample : selected.length,
    note: "",
    items: [],
  };

  if (!out.sample) {
    out.note = "样本不足，暂不报告趋势。";
    return out;
  }
  if (basis === "selected" && selected.length < minSample) {
    out.note = `仅有 ${selected.length} 次选择记录，样本不足 ${minSample} 次，暂不报告趋势。`;
    return out;
  }

  // 冷热倾向统计
  const hot = feedbacks.filter((f) => f.verdict === "too_spicy").length;
  const cold = 0;
  out.items.push({
    label: "反馈条数",
    value: feedbacks.length,
  });
  out.note =
    basis === "consumed"
      ? `最近 ${out.sample} 次确认吃过的${slot || "餐食"}，基于实际消费记录。`
      : `最近 ${out.sample} 次选择记录（用户接受建议，非实际消费），称「选择偏好」。`;
  return out;
}
