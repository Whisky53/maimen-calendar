# 记忆存储结构（maimen-meal）

对应需求说明书 §7「历史知识库」。实现见 `scripts/memory.mjs`。

---

## 存储位置

| 优先级 | 路径 |
| --- | --- |
| 1 | 环境变量 `MAIMEN_MEMORY_PATH` |
| 2 | `~/.maimen/memory.json` |

Windows 下即 `C:\Users\<用户名>\.maimen\memory.json`。

---

## 文件结构

```jsonc
{
  "version": 1,
  "selections": [
    {
      "at": "2026-10-10T07:58:44.168Z",   // ISO 时间
      "slot": "lunch",                     // 餐次
      "purpose": "full-meal",              // 用餐目的
      "id": "c",                           // 餐品/套餐 id（真实 MCP 下为 productCode）
      "name": "打工人基础装备",
      "priceCents": 1950,                  // 整数分；未知为 null
      "status": "verified"                 // 记录时的 dataStatus
    }
  ],
  "feedback": {
    "<id>": { "verdict": "like", "at": "2026-10-10T08:00:00.000Z" }
  }
}
```

`feedback.verdict` 取值：`like` / `dislike`。

---

## 读写规则

| 场景 | 行为 |
| --- | --- |
| 文件不存在 | 视为空记忆，不报错 |
| JSON 损坏 | 降级为空记忆，**不中断推荐** |
| 写入 | 先写 `.tmp-<pid>` 再 `rename`，原子替换，避免半截文件 |
| 写入失败 | 返回 `false`，不抛出 |
| `--no-memory` | 既不读取也不写入 |

---

## 学习范围（AC-36）

**反馈按餐次累积**：早餐的偏好不污染晚餐。

- `memoryForRecommend(mem, { slot })` 只取同一 `slot`（或未标 slot）的历史
- `dislike` 集合全局生效（明确讨厌的不再推荐）
- 历史窗口默认取最近 30 条
- 保留上限 200 条，超出丢弃最旧

---

## 与推荐引擎的接口

```js
const { history, excluded, lastPick } = memoryForRecommend(mem, { slot });
recommend({ settings, meals, history, previous: lastPick, preference, excluded });
```

- `history` → 供给 `summarizeHistory()` 汇总 like/dislike 与「最近 2 次」
- `previous` → 抽签避重复（−20 分）
- `excluded` → 硬剔除集合

---

## 隐私

- 记忆文件只存**餐品 id 与名称**，不存门店位置、不存用户身份
- 不联网上传
- 用户可随时删除该文件，等价于清空记忆
