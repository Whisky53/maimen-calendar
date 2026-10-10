/**
 * 金额工具（共用）。全链路只用「分」做整数运算，仅在展示时转元。
 *
 * 铁律（对应需求说明书 §13.2「统一金额语义」）：
 *   - 缺失价格标 unknown，禁止转成 0
 *   - 预算比较一律用整数分，不做浮点比较
 *   - 展示保留两位小数
 */

/**
 * 解析一个「元」为「分」整数。
 * 无法解析时返回 null（= unknown），绝不返回 0。
 * @param {number|string|null|undefined} yuan
 * @returns {number|null}
 */
export function yuanToCents(yuan) {
  if (yuan === null || yuan === undefined || yuan === "") return null;
  const n = typeof yuan === "number" ? yuan : Number(String(yuan).replace(/[^\d.\-]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** 分 → 元字符串（两位小数）。unknown 返回 "unknown"。 */
export function centsToYuan(cents) {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "unknown";
  return (cents / 100).toFixed(2);
}

/** 分 → 展示用「¥12.00」。unknown 返回「价格未知」。 */
export function fmtYuan(cents) {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "价格未知";
  return `¥${(cents / 100).toFixed(2)}`;
}

/**
 * 预算硬上限判定。unknown 价格视为「不可判定」，不计入预算内。
 * @returns {"within"|"over"|"unknown"}
 */
export function budgetCheck(cents, budgetCents) {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "unknown";
  if (budgetCents === null || budgetCents === undefined || !Number.isFinite(budgetCents)) return "unknown";
  return cents <= budgetCents ? "within" : "over";
}
