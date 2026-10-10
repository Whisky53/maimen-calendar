/**
 * 历史与记忆（maimen-meal）。对应需求说明书 §7「历史知识库」与 references/memory-schema.md。
 *
 * 存储位置：默认 $HOME/.maimen/memory.json（可用 MAIMEN_MEMORY_PATH 覆盖）。
 * 结构：
 *   {
 *     version: 1,
 *     selections: [ { at, slot, purpose, id, name, priceCents, status } ],
 *     feedback:   { "<id>": { verdict: "like"|"dislike", at } }
 *   }
 *
 * 设计要点：
 *   - 读取失败一律降级为「空记忆」，绝不因此中断推荐
 *   - 写入用原子替换（先写临时文件再 rename），避免半截文件
 *   - 学习按同一餐次累积（AC-36）：早餐的反馈不污染晚餐
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_PATH = join(homedir(), ".maimen", "memory.json");

export function memoryPath() {
  return process.env.MAIMEN_MEMORY_PATH || DEFAULT_PATH;
}

const EMPTY = () => ({ version: 1, selections: [], feedback: {} });

/** 读取记忆。任何异常都降级为空记忆。 */
export function loadMemory(path = memoryPath()) {
  try {
    if (!existsSync(path)) return EMPTY();
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object") return EMPTY();
    return {
      version: raw.version || 1,
      selections: Array.isArray(raw.selections) ? raw.selections : [],
      feedback: raw.feedback && typeof raw.feedback === "object" ? raw.feedback : {},
    };
  } catch {
    return EMPTY();
  }
}

/** 原子写入记忆。失败返回 false，不抛出。 */
export function saveMemory(mem, path = memoryPath()) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(mem, null, 2), "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 记录一次选择。
 * @param {object} mem
 * @param {{slot?:string, purpose?:string, id:string, name:string, priceCents?:number|null, status?:string}} pick
 */
export function recordSelection(mem, pick) {
  mem.selections.push({
    at: new Date().toISOString(),
    slot: pick.slot || "lunch",
    purpose: pick.purpose || "full-meal",
    id: pick.id,
    name: pick.name,
    priceCents: Number.isFinite(pick.priceCents) ? pick.priceCents : null,
    status: pick.status || "unknown",
  });
  // 只保留最近 200 条，避免无限增长
  if (mem.selections.length > 200) mem.selections = mem.selections.slice(-200);
  return mem;
}

/**
 * 记录反馈（喜欢/不喜欢）。
 */
export function recordFeedback(mem, id, verdict) {
  if (!id) return mem;
  mem.feedback[String(id)] = { verdict, at: new Date().toISOString() };
  return mem;
}

/**
 * 把记忆整理成推荐引擎认识的形态。
 *
 * @param {object} mem
 * @param {object} [opts]
 * @param {string} [opts.slot]    只取同一餐次的历史（AC-36：学习按餐次累积）
 * @param {number} [opts.window]  只看最近 N 次
 * @returns {{history:Array<{id:string,slot:string}>, excluded:Set<string>, lastPick:string|null}}
 */
export function memoryForRecommend(mem, { slot = null, window = 30 } = {}) {
  const fb = mem.feedback || {};
  const excluded = new Set(
    Object.entries(fb)
      .filter(([, v]) => v && v.verdict === "dislike")
      .map(([k]) => k)
  );

  let seq = (mem.selections || []).slice(-window);
  // 同一餐次的反馈才影响该餐次（避免早餐口味带偏晚餐）
  const slotScoped = slot ? seq.filter((s) => !s.slot || s.slot === slot) : seq;

  const history = slotScoped.map((s) => ({ id: String(s.id), slot: s.slot || "lunch" }));
  const lastPick = slotScoped.length ? String(slotScoped[slotScoped.length - 1].id) : null;

  return { history, excluded, lastPick };
}

/** 统计：某餐次被选过几次（用于 reasons 里给出「你上次也选了它」这类解释）。 */
export function pickCount(mem, id, slot = null) {
  return (mem.selections || []).filter(
    (s) => String(s.id) === String(id) && (!slot || s.slot === slot)
  ).length;
}
