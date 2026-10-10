/**
 * 热量摄入计算 + 训练计划联动。
 *
 * 设计原则：
 * - 热量数据来自麦当劳 MCP 官方营养表（160 条，实测），不做估算。
 * - 训练消耗用 MET 公式估算，明确标注「估算」。
 * - 只做「收支平衡」的可解释建议，不做医疗/营养诊断。
 */

/** 活动强度 → MET 值（代谢当量）。来源：通用运动代谢指南区间中位值。 */
export const MET_TABLE = {
  rest: { met: 1.0, label: "静息" },
  walk: { met: 3.0, label: "慢走" },
  run: { met: 8.5, label: "跑步" },
  cycle: { met: 6.5, label: "骑行" },
  swim: { met: 7.0, label: "游泳" },
  strength: { met: 5.0, label: "力量训练" },
  yoga: { met: 3.0, label: "瑜伽" },
  hiit: { met: 9.0, label: "高强度间歇" },
  badminton: { met: 5.5, label: "羽毛球" },
  basketball: { met: 6.5, label: "篮球" },
};

/**
 * 训练消耗估算（MET × 体重kg × 时长h）。
 * @param {object} session { type, minutes, weightKg }
 */
export function burnOf({ type = "rest", minutes = 0, weightKg = 65 }) {
  const entry = MET_TABLE[type] || MET_TABLE.rest;
  const hours = Math.max(0, Number(minutes) || 0) / 60;
  const kcal = Math.round(entry.met * weightKg * hours);
  return { kcal, met: entry.met, label: entry.label, minutes, type };
}

/**
 * 汇总一天的训练计划消耗。
 * @param {Array} plan [{ type, minutes, weightKg }]
 */
export function burnOfPlan(plan = []) {
  const items = plan.map((s) => burnOf(s));
  const total = items.reduce((a, b) => a + b.kcal, 0);
  return { total, items };
}

/** 基础代谢估算（Mifflin-St Jeor）。性别、年龄、身高、体重。 */
export function bmr({ gender = "female", weightKg = 55, heightCm = 163, age = 30 } = {}) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return Math.round(gender === "male" ? base + 5 : base - 161);
}

/**
 * 每日可摄入热量估算（TDEE）。
 * @param {object} profile { gender, weightKg, heightCm, age, activityFactor }
 * activityFactor: 1.2 久坐 / 1.375 轻度 / 1.55 中度 / 1.725 高强度
 */
export function tdee(profile = {}) {
  const { activityFactor = 1.375 } = profile;
  return Math.round(bmr(profile) * activityFactor);
}

/**
 * 热量收支分析。
 * @param {object} opts
 * @param {number} opts.intakeKcal    这顿/今日已摄入
 * @param {number} opts.burnKcal      训练消耗
 * @param {number} opts.targetKcal    目标摄入（如 TDEE 或预算）
 * @param {object} [opts.meal]        餐品营养明细
 */
export function balance({ intakeKcal = 0, burnKcal = 0, targetKcal = null, meal = null }) {
  const net = intakeKcal - burnKcal;
  const out = {
    intakeKcal,
    burnKcal,
    netKcal: net,
    targetKcal,
    meal,
    verdictNote: "",
    verdict: "unknown",
  };

  if (targetKcal) {
    const remain = targetKcal - net;
    out.remainKcal = remain;
    if (remain > 300) {
      out.verdict = "surplus";
      out.verdictNote = `今日还有约 ${remain} kcal 余量，这顿吃得比较克制。`;
    } else if (remain >= -100) {
      out.verdict = "balanced";
      out.verdictNote = `基本贴合目标（差 ${Math.abs(remain)} kcal），收支平衡。`;
    } else {
      out.verdict = "over";
      out.verdictNote = `超出目标约 ${Math.abs(remain)} kcal，晚些可加点活动或晚餐收一收。`;
    }
  } else {
    out.verdictNote = `净摄入 ${net} kcal（摄入 ${intakeKcal} − 消耗 ${burnKcal}）。`;
  }

  if (burnKcal >= 300) {
    out.verdictNote += ` 今天训练消耗 ${burnKcal} kcal，是笔不小的支出。`;
  }
  return out;
}

/**
 * 按热量「预算」给餐品打分。
 *
 * ⚠️ 关键：不是越低越好。
 * 一顿正餐需要足够的能量与蛋白质，热量过低反而是坏选择（比如一杯 88 kcal 的果汁）。
 * 所以在 maxKcal 之上再加一个 minKcal 下限，低于下限扣分。
 *
 * @param {object} mealNutrition { kcal, protein, fat, carb }
 * @param {object} goal { maxKcal, minKcal, minProtein }
 */
export function nutritionScore(mealNutrition, goal = {}) {
  if (!mealNutrition) return { score: 0, reasons: [] };
  const reasons = [];
  let score = 0;
  const kcal = mealNutrition.kcal || 0;
  const minKcal = goal.minKcal != null ? goal.minKcal : 350; // 正餐能量下限

  if (goal.maxKcal) {
    if (kcal <= goal.maxKcal) {
      score += 4;
      reasons.push(`${kcal} kcal，在 ${goal.maxKcal} kcal 目标内`);
    } else {
      score -= 5;
      reasons.push(`${kcal} kcal，超出 ${goal.maxKcal} kcal 目标`);
    }
  }
  // 能量下限：太"轻"的不适合当正餐
  if (kcal && kcal < minKcal) {
    score -= 6;
    reasons.push(`${kcal} kcal 偏低，不够当一顿正餐`);
  } else if (kcal) {
    score += 3;
    reasons.push(`${kcal} kcal，能量上够一顿正餐`);
  }

  if (goal.minProtein && mealNutrition.protein != null) {
    if (mealNutrition.protein >= goal.minProtein) {
      score += 3;
      reasons.push(`蛋白质 ${mealNutrition.protein}g，达标`);
    } else {
      score -= 1;
      reasons.push(`蛋白质 ${mealNutrition.protein}g，未达 ${goal.minProtein}g`);
    }
  }
  return { score, reasons };
}

/** 内置训练计划模板。 */
export const TRAINING_TEMPLATES = {
  fatLoss: {
    label: "减脂",
    weekly: [
      { day: 1, type: "run", minutes: 40 },
      { day: 3, type: "strength", minutes: 40 },
      { day: 5, type: "hiit", minutes: 25 },
      { day: 6, type: "cycle", minutes: 45 },
    ],
  },
  muscle: {
    label: "增肌",
    weekly: [
      { day: 1, type: "strength", minutes: 60 },
      { day: 2, type: "strength", minutes: 60 },
      { day: 4, type: "strength", minutes: 60 },
      { day: 5, type: "strength", minutes: 60 },
    ],
  },
  maintain: {
    label: "维持",
    weekly: [
      { day: 1, type: "walk", minutes: 40 },
      { day: 3, type: "yoga", minutes: 45 },
      { day: 6, type: "badminton", minutes: 60 },
    ],
  },
};

/**
 * 把周模板展开到具体日期区间。
 * @param {object} tpl TRAINING_TEMPLATES 中的一项
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate   YYYY-MM-DD
 */
export function expandPlan(tpl, startDate, endDate) {
  const out = [];
  const start = new Date(startDate + "T00:00:00");
  const end = new Date(endDate + "T00:00:00");
  if (isNaN(start) || isNaN(end)) return out;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    // JS getDay(): 0=周日；模板用 1=周一
    const dow = d.getDay() === 0 ? 7 : d.getDay();
    const hit = (tpl.weekly || []).find((w) => w.day === dow);
    if (!hit) continue;
    const p = (n) => String(n).padStart(2, "0");
    out.push({
      date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
      type: hit.type,
      minutes: hit.minutes,
      label: (MET_TABLE[hit.type] || {}).label || hit.type,
    });
  }
  return out;
}
