/**
 * 提醒设置（maimen-calendar）。对应需求说明书 §8.1。
 *
 * 存储：默认 $HOME/.maimen/reminders.json（可用 MAIMEN_REMINDERS_PATH 覆盖）。
 *
 * 设计要点：
 *   - 每个餐次**独立开关**，不默认开启全部餐次
 *   - 每个餐次可分别设时间、预算、重复规则
 *   - 首次设置需确认餐次/时间/时区/重复规则；已有明确要求不重复确认
 *   - 支持：修改 / 关闭 / 跳过当天某餐 / 暂停全天 / 延后本次
 *   - 工作日不等于法定工作日：调休与节假日须有可靠日历来源或用户自定义
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_PATH = join(homedir(), ".maimen", "reminders.json");

export const SETTINGS_VERSION = 1;

/** 各餐次的可选时间模板（§8.1）。 */
export const TIME_TEMPLATES = {
  breakfast: "08:00",
  lunch: "11:30",
  dinner: "18:30",
};

/** 重复规则。 */
export const REPEAT_RULES = Object.freeze({
  DAILY: "daily",
  WEEKDAYS: "weekdays", // 周一至周五（**不等于**法定工作日）
  CUSTOM: "custom",
});

export function remindersPath() {
  return process.env.MAIMEN_REMINDERS_PATH || DEFAULT_PATH;
}

function emptySettings() {
  return {
    version: SETTINGS_VERSION,
    configured: false, // 是否已完成首次确认
    timezone: "Asia/Shanghai",
    slots: {}, // slot → { enabled, time, budget, repeat, days }
    paused: null, // { from, to, reason } 暂停全天
    skipDates: [], // [{ date, slot }] 跳过当天某餐
    snooze: {}, // slot → ISO 时间（延后本次）
    customWorkdays: null, // 用户自定义工作日（覆盖默认周一至周五）
    holidays: [], // 用户自定义节假日 ["2026-10-01", ...]
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  };
}

export function loadReminders(path = remindersPath()) {
  try {
    if (!existsSync(path)) return emptySettings();
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object") return emptySettings();
    return { ...emptySettings(), ...raw };
  } catch {
    return emptySettings();
  }
}

export function saveReminders(s, path = remindersPath()) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    s.meta = { ...(s.meta || {}), updatedAt: new Date().toISOString() };
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 首次设置：确认餐次、时间、时区、重复规则。
 * 已有明确要求不重复确认（configured 为 true 时只做增量合并）。
 *
 * @param {object} s
 * @param {object} input
 * @param {Array<{slot:string,time?:string,budget?:number,repeat?:string}>} input.slots
 * @param {string} [input.timezone]
 */
export function configureSlots(s, { slots = [], timezone } = {}) {
  if (!s || typeof s !== "object") s = emptySettings();
  if (!s.slots || typeof s.slots !== "object") s.slots = {};
  if (timezone) s.timezone = timezone;
  for (const item of slots) {
    if (!item || !item.slot) continue;
    const prev = s.slots[item.slot] || {};
    s.slots[item.slot] = {
      enabled: item.enabled != null ? Boolean(item.enabled) : prev.enabled != null ? prev.enabled : true,
      time: item.time || prev.time || TIME_TEMPLATES[item.slot] || "12:00",
      budget: item.budget != null ? Number(item.budget) : prev.budget != null ? prev.budget : null,
      repeat: item.repeat || prev.repeat || REPEAT_RULES.DAILY,
      days: item.days || prev.days || null,
    };
  }
  s.configured = true;
  return s;
}

/** 修改/关闭某餐次。 */
export function setSlot(s, slot, patch = {}) {
  if (!s.slots) s.slots = {};
  const prev = s.slots[slot] || { enabled: false, time: TIME_TEMPLATES[slot] || "12:00", budget: null, repeat: REPEAT_RULES.DAILY, days: null };
  s.slots[slot] = { ...prev, ...patch };
  if (patch.budget != null) s.slots[slot].budget = Number(patch.budget);
  return s;
}

/**
 * 判断某天该餐次是否该提醒。
 *
 * ⚠️ §8.1：**周一至周五不等于法定工作日**。
 *    - 有可靠日历来源时，用 holidays/customWorkdays 判断
 *    - 无来源时，`weekdays` 规则只表示「周一至周五」，并在输出里明说
 *
 * @param {object} s 设置
 * @param {string} slot
 * @param {string} date YYYY-MM-DD
 * @returns {{remind:boolean, reason:string, weekdayOnly:boolean}}
 */
export function shouldRemind(s, slot, date) {
  const cfg = s && s.slots ? s.slots[slot] : null;
  if (!cfg || !cfg.enabled) return { remind: false, reason: "该餐次未开启", weekdayOnly: false };
  if (s.paused) {
    const { from, to } = s.paused;
    if ((!from || date >= from) && (!to || date <= to)) {
      return { remind: false, reason: "全天已暂停", weekdayOnly: false };
    }
  }
  if ((s.skipDates || []).some((x) => x.date === date && (!x.slot || x.slot === slot))) {
    return { remind: false, reason: "该餐次当天已跳过", weekdayOnly: false };
  }
  if (cfg.repeat === REPEAT_RULES.WEEKDAYS) {
    const dow = new Date(`${date}T00:00:00`).getDay();
    const isWeekend = dow === 0 || dow === 6;
    if (isWeekend) return { remind: false, reason: "周末按周一至周五规则跳过", weekdayOnly: true };
    // 若是调休上班日 / 已标记节假日，按用户配置处理
    const isHoliday = (s.holidays || []).includes(date);
    if (isHoliday) return { remind: false, reason: "用户标记的节假日", weekdayOnly: false };
  }
  if (cfg.repeat === REPEAT_RULES.CUSTOM && Array.isArray(cfg.days)) {
    const dow = new Date(`${date}T00:00:00`).getDay();
    if (!cfg.days.includes(dow)) return { remind: false, reason: "不在自定义重复日", weekdayOnly: false };
  }
  // 延后本次：仅跳过当天
  const sn = s.snooze && s.snooze[slot];
  if (sn && String(sn).slice(0, 10) === date) {
    return { remind: false, reason: `本次已延后到 ${sn}`, weekdayOnly: false };
  }
  return { remind: true, reason: "按设置提醒", weekdayOnly: cfg.repeat === REPEAT_RULES.WEEKDAYS };
}

/** 暂停全天。 */
export function pauseAll(s, { from = null, to = null, reason = "" } = {}) {
  s.paused = { from, to, reason };
  return s;
}

export function resumeAll(s) {
  s.paused = null;
  return s;
}

/** 跳过当天某餐。 */
export function skipDay(s, { date, slot = null }) {
  if (!s.skipDates) s.skipDates = [];
  if (!s.skipDates.some((x) => x.date === date && x.slot === slot)) {
    s.skipDates.push({ date, slot });
  }
  return s;
}

/** 延后本次（到指定时间或推迟 N 分钟）。 */
export function snooze(s, { slot, until = null, minutes = 30 }) {
  if (!s.snooze) s.snooze = {};
  const t = until || new Date(Date.now() + minutes * 60000).toISOString();
  s.snooze[slot] = t;
  return s;
}

/** 汇总当前配置，供输出与用户确认。 */
export function summarize(s) {
  const slots = s && s.slots ? s.slots : {};
  return {
    configured: Boolean(s && s.configured),
    timezone: (s && s.timezone) || "Asia/Shanghai",
    paused: (s && s.paused) || null,
    slots: Object.entries(slots).map(([slot, cfg]) => ({
      slot,
      ...cfg,
      weekdayOnly: cfg.repeat === REPEAT_RULES.WEEKDAYS,
    })),
    warnings: [
      ...(Object.values(slots).some((c) => c.repeat === REPEAT_RULES.WEEKDAYS)
        ? ["「周一至周五」不等于法定工作日；调休与节假日需可靠日历来源或用户自定义，本工具不做假定。"]
        : []),
    ],
  };
}
