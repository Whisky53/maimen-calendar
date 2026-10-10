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
  "memory":        { "used", "historyCount", "lastPick", "excludedCount",
                     "schemaVersion", "eventCount", "recentSameSlot", "crossSlotCount", "windowDays" },
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

---

## memory 段（§7.3 分析输出口径）

`memory` 段必须如实反映「这次推荐用到了什么历史」，不得含糊其辞。

| 字段 | 含义 |
| --- | --- |
| `used` | 本次是否读取了历史记忆（`--no-memory` 时为 `false`） |
| `historyCount` | 进入本次推荐的历史条数 |
| `lastPick` | 最近同餐次吃过的餐品 id（用于避重） |
| `excludedCount` | 硬排除集合大小（明确不喜欢等） |
| `schemaVersion` | 记忆 Schema 版本（当前 `2`） |
| `eventCount` | 窗口内参与计算的事件数 |
| `recentSameSlot` | 最近 3 次同餐次吃过的餐品 |
| `crossSlotCount` | 跨餐次弱信号条数 |
| `windowDays` | 读取窗口天数（默认 30） |

### 口径要求（§7.3）

**只有 `consumed` 才算「实际消费」。** 措辞必须区分：

| 记录情况 | 允许的措辞 | 禁止的措辞 |
| --- | --- | --- |
| 有 ≥3 次 `consumed` | 「基于最近 N 次**实际消费**」 | — |
| 只有 `selected` | 「最近 N 次**选择记录**（用户接受了建议，非实际消费），称『选择偏好』」 | ❌「你最近吃了 N 次」 |
| 样本 < 3 | 「样本不足，暂不报告趋势」 | ❌ 硬凑出趋势结论 |

### 清空与派生偏好

用户清空历史时，**由历史派生的偏好必须一并清除或重建**（§7.2）：

- `inferred`（统计推断）→ 清空
- `confirmed`（用户明确确认的忌口/过敏）→ 默认**保留**；仅显式全清时才一并删除

不得出现「事件已清空、但偏好还在生效」的中间状态而不告知用户。
