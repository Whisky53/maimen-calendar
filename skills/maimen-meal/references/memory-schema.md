# 记忆存储结构（maimen-meal）

对应需求说明书 §7「历史知识库与反馈学习」。实现见 `scripts/memory.mjs`。

---

## 存储位置

| 优先级 | 路径 |
| --- | --- |
| 1 | 环境变量 `MAIMEN_MEMORY_PATH` |
| 2 | `~/.maimen/memory.json` |

Windows 下即 `C:\Users\<用户名>\.maimen\memory.json`。

---

## Schema 版本

当前为 **v2（事件流）**。

v1 是「`selections` 数组 + `feedback` 映射」两段式，只能表达「选过」和「喜欢/不喜欢」。
v2 改为**七类事件流**，因为「展示过」「选过」「吃过」「换过」「反馈过」在语义上完全不同，
混在一起会把「看了一眼」误当成「吃过」，进而污染推荐。

v1 数据**自动迁移、不丢失**（见下「迁移规则」），不通过清空存储来掩盖 Schema 变更。

---

## 事件类型（§7.1）

| 类型 | 含义 | 是不是偏好证据 |
| --- | --- | --- |
| `recommendation_shown` | 向用户展示了某项推荐 | ❌ 只是曝光，不是偏好 |
| `selected` | 用户**选择了**该建议 | ⚠️ **弱证据**，不代表购买或吃过 |
| `consumed` | 用户**确认吃过**该餐品 | ✅ 最强的正向证据 |
| `rerolled` | 用户点了「换一个」 | ⚠️ 只在本轮避重，**不形成长期厌恶** |
| `feedback` | 用户给出明确反馈（见下表） | ✅ 明确偏好 |
| `skipped` | 用户明确跳过 | ⚠️ 弱负向 |
| `preference_updated` | 用户明确修改了忌口/过敏等设置 | ✅ **最权威**，不得被推断覆盖 |

**关键区分**：`selected` ≠ `consumed`。
只有 `consumed` 才算「实际消费」；只凭 `selected` 时，任何分析都只能说「选择偏好」（§7.3）。

### 反馈原因（`feedback.verdict`）

| 值 | 含义 |
| --- | --- |
| `like` | 喜欢 |
| `dislike` | 不喜欢（**同时写入 `confirmed.dislikes`**） |
| `too_spicy` | 太辣 |
| `too_expensive` | 太贵 |
| `too_cold` | 太凉 |
| `too_hot` | 太烫 |

保存原始反馈值，**按原因更新偏好**，而不是只记一个「好/坏」布尔量。

---

## 文件结构（v2）

```jsonc
{
  "schemaVersion": 2,
  "events": [
    {
      "schemaVersion": 2,
      "eventId": "a1b2c3…",              // 32 位；同 id 不重复写入（幂等）
      "userId": "local",
      "requestId": null,                  // 同一次请求内的关联 id
      "type": "consumed",                 // 七类之一
      "at": "2026-10-10T07:58:44.168Z",   // ISO 时间
      "mealId": "c",                      // 餐品/套餐 id（真实 MCP 下为 productCode）
      "name": "打工人基础装备",
      "mealSlot": "lunch",                // 餐次：breakfast/lunch/dinner/late-night/snack
      "mealPurpose": "full-meal",         // 用餐目的
      "priceCents": 1950,                 // 整数分；**未知为 null，绝不写 0**
      "storeCode": null,                  // 门店编码（不存门店位置）
      "verdict": null,                    // 仅 feedback 用
      "reason": null,
      "sourceSnapshot": { "source": "cli", "status": "verified" },
      "note": null
    }
  ],
  "confirmed": {                          // 用户**明确确认**的偏好，不得被推断覆盖
    "dislikes": ["c1"],
    "allergies": ["花生"],
    "globalBans": ["冰淇淋"]
  },
  "inferred": {                           // 由统计推断，**必须标注为推断，不得升级为禁忌**
    "notes": [{ "at": "…", "note": "…", "kind": "inferred" }]
  },
  "meta": { "createdAt": "…", "updatedAt": "…", "migratedFrom": 1 }
}
```

---

## 读写规则

| 场景 | 行为 |
| --- | --- |
| 文件不存在 | 视为空记忆，不报错 |
| JSON 损坏 | 降级为空记忆，**不中断推荐** |
| 写入 | 先写 `.tmp-<pid>-<ts>` 再 `rename`，原子替换，避免半截文件 |
| 写入失败 | 返回 `false`，不抛出 |
| 重复 `eventId` | 不重复写入（`appendEvent` 返回 `false`） |
| `--no-memory` | 既不读取也不写入 |

### 幂等（§7.2）

同一业务动作重试**不得重复写入**。用 `deterministicId(...parts)`（sha1 截 32 位）生成确定性
`eventId`，同样的「用户 + 动作 + 餐品 + 日期 + 餐次」永远得到同一个 id，重试自然去重。

---

## 保留期与窗口

| 项 | 默认 | 环境变量 |
| --- | --- | --- |
| 原始事件保留 | **180 天** | `MAIMEN_RETENTION_DAYS` |
| 推荐读取窗口 | **30 天** | `MAIMEN_WINDOW_DAYS` |

- **保留期**：超过 180 天的原始事件由 `purgeExpired()` 清理。**只在显式调用时执行**，不偷偷自动删。
- **窗口**：`deriveMemory()` 只看最近 30 天。窗口外的事件**仍留在存储里**，只是不参与当前推荐。

---

## 派生视图规则（§7.2）

`deriveMemory(store, { slot, windowDays })` 的输出：

| 字段 | 规则 |
| --- | --- |
| `likes` | 窗口内 `feedback.verdict === "like"` 的餐品 |
| `dislikes` | 窗口内 `feedback.verdict === "dislike"` ∪ `confirmed.dislikes` |
| `rerolledThisRound` | 窗口内 `rerolled` 的餐品，**仅本轮避重** |
| `recentSameSlot` | 最近 **3 次** `consumed` 且**同餐次**的餐品（倒序） |
| `recentAnySlot` | 最近 3 次 `consumed`（不分餐次） |
| `crossSlotPenalty` | `recentAnySlot` 中不属于 `recentSameSlot` 的，作**弱信号**（权重 0.3） |
| `pickCounts` | `selected` + `consumed` 的次数统计 |

### 同餐次优先

重复度**优先比较同餐次**，跨餐次只作较弱信号 —— 早餐喝咖啡**不推断**晚餐也不喝咖啡。
但**明确过敏与全局忌口跨餐次生效**。

### 确认 vs 推断

- `confirmed`（用户明确说过）= 权威，**不被 `inferred` 覆盖**
- `inferred`（统计推断）= 参考，**不得升级为禁忌**
- 代码里二者物理隔离在不同字段，且推断只写 `inferred.notes`，永远不写 `confirmed.dislikes`

---

## 与推荐引擎的接口

```js
const { history, excluded, lastPick, crossSlotPenalty, view } =
  memoryForRecommend(store, { slot });
recommend({ settings, meals, history, previous: lastPick, preference, excluded });
```

- `history` → 供给 `summarizeHistory()` 汇总 like/dislike 与「最近 2 次」
- `previous` → 抽签避重复（−20 分）
- `excluded` → 硬剔除集合
- `crossSlotPenalty` → 跨餐次弱信号，**降权处理**，不等同硬排除

---

## 分析输出口径（§7.3）

`trendReport(store, { slot, minSample = 3 })`：

| 条件 | `basis` | `basisLabel` |
| --- | --- | --- |
| `consumed` ≥ 3 次 | `consumed` | **实际消费** |
| 只有 `selected` 且 ≥ 3 次 | `selected` | **选择偏好** |
| 样本不足 3 次 | 原 basis | 明说「样本不足，暂不报告趋势」 |

**不得**把 `selected` 说成「实际消费」。样本不足时**不报告趋势**，而不是硬凑结论。

---

## 用户操作

| 命令 | 行为 |
| --- | --- |
| `--view` | 列出最近事件 + 趋势口径 |
| `--view-type <type>` | 只看某类事件 |
| `--record <consumed\|selected\|rerolled\|skipped>` | 记事件（幂等） |
| `--feedback <verdict> --feedback-id <id>` | 记反馈；`dislike` 同步写 `confirmed.dislikes` |
| `--revoke <id>` | 撤销反馈，**同步从 `confirmed` 摘除** |
| `--confirm-dislike / --confirm-allergy / --confirm-ban` | 明确确认（写 `preference_updated` 事件） |
| `--unconfirm <id\|词>` | 取消某条明确确认 |
| `--export` | 导出全部记忆为 JSON |
| `--clear-keep-confirmed` | 清空事件与**推断**偏好，保留明确确认的忌口/过敏 |
| `--clear` | 全清（含明确确认） |
| `--purge` | 清理超过保留期的事件 |

**清空语义（§7.2）**：清空历史时**同时清除或重建由历史派生的偏好**。
派生偏好（`inferred`）一并清掉；用户明确确认的（`confirmed`）默认保留，除非显式 `--clear`。

---

## 迁移规则（v1 → v2）

自动发生，**数据不丢失**：

| v1 | → v2 |
| --- | --- |
| `selections[]` | 每条转为 `selected` 事件（`sourceSnapshot.source = "v1-migration"`） |
| `feedback[id]` | 每条转为 `feedback` 事件 |
| `feedback[id].verdict === "dislike"` | **额外**迁入 `confirmed.dislikes`（属用户明确表达） |
| `meta` | 保留 `createdAt`，标记 `migratedFrom: 1` |

---

## 隐私

- 记忆文件只存**餐品 id 与名称**，不存门店位置、不存用户身份
- 不联网上传
- 用户可随时删除该文件，等价于清空记忆
