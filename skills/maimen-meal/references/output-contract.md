# 输出合同（maimen-meal）

程序以 `--json` 输出时，必须符合以下结构。面向用户的自然语言回复不要求照搬，
但**字段语义必须一致**：不得把 `unknown` 说成具体数字，不得把 `demo` 说成真实结果。

---

## 顶层结构

```jsonc
{
  "meta":          { "generatedAt", "tool", "version" },
  "context":       { "slot", "slotLabel", "purpose", "purposeLabel", "store" },
  "constraints":   { "budget", "budgetHardLimit", "drink", "noSpicy", "slot", "purpose" },
  "sources":       { "<key>": { "source", "status", "scope", "validFor?", "note?" } },
  "recommendation":{ "id", "name", "priceCents", "price", "priceStatus", "category", "temp" } | null,
  "comparison":    { "status", "best", "all" } | null,
  "reasons":       [ "string" ],
  "memory":        { "used", "historyCount", "lastPick", "excludedCount" },
  "reminder":      { "note" } | null,
  "warnings":      [ "string" ],
  "dataStatus":    "verified" | "verified-unpriced" | "demo" | "failed" | "no-solution",
  "eligibleCount":  number
}
```

---

## sources 的 status 取值

| status | 含义 |
| --- | --- |
| `verified` | 来自官方接口，本次调用成功返回 |
| `estimated` | 由规则推算，非官方直出 |
| `unknown` | 数据缺失，**不得当作 0 或默认值使用** |
| `stale` | 有数据但已过期 |
| `demo` | 演示数据，仅用于无 Token 时保证流程可跑 |

每个来源都必须同时给出 `source`（怎么来的）与 `scope`（作用范围，如 `store=xxx`）。

---

## dataStatus 取值（整体结果状态）

| 值 | 含义 | 用户可见话术要求 |
| --- | --- | --- |
| `verified` | 真实菜单 + 服务端核价成功 | 可称「价格已核验」 |
| `verified-unpriced` | 真实菜单，但核价未成功 | 必须说明「以菜单标价为准」 |
| `demo` | 演示数据 | 必须说明「非真实门店报价」 |
| `failed` | 服务不可达或调用失败 | 必须说明服务不可用，**不得回退演示并伪装** |
| `no-solution` | 业务无解（预算内无候选） | 说明原因，**不得回退全菜单** |

---

## 金额口径

- 全链路内部用**整数分**（`priceCents`）
- 展示转元保留两位小数（`price`）
- 缺失价格：`priceCents: null`、`price: "价格未知"`、`priceStatus: "unknown"`
- **禁止把缺失价格写成 0 或 ¥0.00**

---

## reasons 的写法

每条理由必须**可追溯到某个具体条件或数据**，例如：

- ✅ 「预算内，还剩 ¥10.50」——可核算
- ✅ 「餐次：午餐 · 目的：正餐」——可追溯
- ✅ 「服务端实付核价 ¥31.00（已验证）」——可追溯来源
- ❌ 「性价比很高」——无依据
- ❌ 「根据大数据推荐」——编造来源

核价失败时写「服务端核价未成功（原因），以下价格以菜单标价为准」，
不得仍写「服务端实付精算」。

---

## warnings 必须覆盖的情况

- 服务失败（传输 / 业务错误）
- 业务无解及其原因
- 使用演示数据
- 门店为候选首项而非确认过的常用门店
- 关键数据缺失（如热量）

---

## 提醒与日历的关系

`reminder` 只承载「只询价、不下单、不付款」的说明。
真正的日历事件由 `maimen-calendar` 生成，UID 规则见该 Skill 的 `references/calendar-rules.md`。
