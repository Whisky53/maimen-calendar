/**
 * 来源状态工具（共用）。对应需求说明书 §11「来源与状态」。
 *
 * 每一个数据对象都必须能回答四个问题：
 *   从哪来（source）、可不可信（status）、什么时候取的（fetchedAt）、范围与有效期（scope/validFor）
 *
 * status 取值（至少覆盖这五种，不得自造）：
 *   verified  —— 来自官方接口，且本次调用成功返回
 *   estimated —— 由规则推算，非官方直出（如按营养表估算）
 *   unknown   —— 数据缺失，不得当作 0 或默认值使用
 *   stale     —— 有数据但已过期（超过 validFor）
 *   demo      —— 演示数据，仅用于无 Token 时保证流程可跑
 */

export const SOURCE_STATUS = Object.freeze({
  VERIFIED: "verified",
  ESTIMATED: "estimated",
  UNKNOWN: "unknown",
  STALE: "stale",
  DEMO: "demo",
});

/**
 * 构造一个带来源状态的对象。
 * @param {object} p
 * @param {any} p.value        数据本体（可为 null）
 * @param {string} p.source    来源标识，如 "mcd-mcp:query-meals"
 * @param {string} p.status    SOURCE_STATUS 之一
 * @param {string} [p.scope]   作用范围，如 "store=xxx" / "city=广州" / "global"
 * @param {string} [p.validFor] 有效期描述，如 "2026-10-09" / "PT6H"
 * @param {string} [p.note]    补充说明
 */
export function sourced({ value, source, status, scope = "global", validFor = null, note = "" }) {
  return {
    value,
    source,
    status,
    scope,
    fetchedAt: new Date().toISOString(),
    validFor,
    ...(note ? { note } : {}),
  };
}

/** 未知来源的便捷构造（value 必须显式为 null）。 */
export function unknownSource(source, scope = "global", note = "") {
  return sourced({ value: null, source, status: SOURCE_STATUS.UNKNOWN, scope, note });
}

/** 演示来源的便捷构造。 */
export function demoSouce(source, value, scope = "global", note = "演示数据，非真实门店报价") {
  return sourced({ value, source, status: SOURCE_STATUS.DEMO, scope, note });
}

/**
 * 把一组带来源状态的条目汇总成 sources 段，用于输出合同 §12。
 * @param {Array<{key:string}&object>} list
 */
export function collectSources(list) {
  const out = {};
  for (const item of list) {
    if (!item || !item.key) continue;
    const { key, ...rest } = item;
    out[key] = rest;
  }
  return out;
}
