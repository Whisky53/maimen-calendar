---
name: maimen-meal
description: 麦门这一餐 · 预算内帮你选、价格帮你核。按餐次（早餐/午餐/晚餐/夜宵/加餐）与用餐目的（正餐/轻食/仅饮品），结合预算、冷热偏好、忌口、天气与星座倾向，从麦当劳菜单中推荐一份可执行的方案；接入麦当劳 MCP 时查真实菜单与优惠券，并用服务端精算核验应付价格，确保核价集合与最终推荐一致。当用户说"今天吃什么""帮我选午饭/晚饭/早餐""预算内推荐麦当劳""今天天气适合吃啥""算一下哪个套餐最便宜"时使用。
---

# 麦门这一餐 · 今天吃什么

一餐决策助手。核心目标一句话：**上班已经够难了，吃饭别再做选择题。**

## 职责

在用户给定（或默认）的预算、口味、餐次约束下，输出**一份可执行、价格经核验**的推荐，并说清为什么是它。
不做下单、不做支付，只询价。

## 必要输入

- **预算**（可选，默认 30 元，硬上限）
- **餐次**（可选，默认按当前时间推断）
- **用餐目的**（可选，默认按餐次推断）
- 口味偏好 / 忌口 / 星座（可选）

## 正常执行步骤

1. 解析入参：餐次、用餐目的、预算、忌口、天气、星座 → 合成偏好信号
2. 读记忆（同餐次历史与反馈）
3. 查门店（有 MCP 时）→ 拉真实菜单 → 组装候选（空即无解）
4. 硬约束过滤 → 软偏好排序 → 在最优档内抽签
5. **只对最终推荐单元**做服务端核价
6. 写回记忆 → 输出推荐 + 理由 + 价格来源状态

## 硬约束（不可违背）

- 预算为**硬上限**，不做任何倍数放宽
- 金额全链路用整数分，缺失价格标 `unknown`，**绝不按 0 计**
- 核价失败的候选不进入最终推荐，且**不静默丢弃**
- 硬约束（预算/忌口/排除）永不被软偏好或随机性突破
- 只询价，不创建订单、不付款、不扣积分
- 无 Token 时标记 `status=demo`，**不伪装成真实结果**

## 关键异常

| 情况 | 处理 |
| --- | --- |
| 预算内无合格候选 | 返回「无解」+ 原因，**不回退全菜单** |
| MCP 传输失败 | 标 `dataStatus=failed`，明确告知服务不可用，不回退演示 |
| 部分候选核价失败 | 保留失败记录，说明「以菜单标价为准」 |
| 记忆文件损坏 | 降级为空记忆，不中断推荐 |

## 输出规则

按 `references/output-contract.md` 的 JSON 合同输出。
面向用户时给一句话结论 + 理由 + 价格，不倾倒原始 JSON。

## 按需引用

- `references/recommendation-rules.md` — 餐次/目的定义、打分规则、抽签、无解处理
- `references/mcd-tools.md` — MCP 工具清单与实测字段事实
- `references/memory-schema.md` — 历史与反馈存储结构
- `references/output-contract.md` — 输出 JSON 合同与来源状态
- `references/acceptance.md` — 验收用例与实测记录
- `../shared/` — MCP 传输层、金额工具、来源状态

<!-- 以下为工程实现说明，供维护者参考，不作为 Skill 执行指令 -->

## 快速开始

```bash
cd scripts

# 基础推荐（离线演示数据）
node run.mjs --budget 30 --slot lunch --drink hot --no-spicy

# 早餐只要轻食
node run.mjs --slot breakfast --purpose light-meal --budget 20

# 结合天气与星座
node run.mjs --budget 30 --weather '{"tempC":5,"precipitation":"rain"}' --birthday 2000-08-15

# JSON 输出（供程序消费）
node run.mjs --budget 25 --json

# 接入真实 MCP
export MCD_MCP_TOKEN=你的token
node run.mjs --budget 40 --city 上海 --weather '{"tempC":32}'

# 完整端到端联调自检（只询价，不下单）
MCD_MCP_TOKEN=你的token node verify-mcp.mjs --city 上海 --budget 30
```

## 参数

| 参数 | 取值 | 默认 |
| --- | --- | --- |
| `--budget` | 元（硬上限） | 30 |
| `--slot` | `breakfast` / `lunch` / `dinner` / `late-night` / `snack` | 按当前时间 |
| `--purpose` | `full-meal` / `light-meal` / `drink-only` | 按餐次 |
| `--drink` | `any` / `hot` / `cold` | any |
| `--no-spicy` | 开关 | 关 |
| `--city` | 城市名（真实 MCP 时查门店用） | 上海 |
| `--birthday` | `YYYY-MM-DD` | 无 |
| `--weather` | JSON 或 `"温度,降水"` | 无 |
| `--store` | 门店 storeCode（跳过门店查询） | 无 |
| `--no-memory` | 本次不读写历史记忆 | 关 |
| `--json` / `--demo` / `--zodiacs` | 输出 JSON / 强制演示 / 列出星座 | 关 |

## 环境变量

| 变量 | 用途 | 必填 |
| --- | --- | --- |
| `MCD_MCP_TOKEN` | 麦当劳 MCP Token | 否（缺省走演示数据） |
| `MCD_MCP_URL` | MCP 接入地址 | 否（默认 `https://mcp.mcd.cn`） |
| `MAIMEN_MEMORY_PATH` | 记忆文件路径 | 否（默认 `~/.maimen/memory.json`） |

> **Token 安全**：只通过环境变量注入，绝不写入源码、仓库、配置示例或日志。

## 模块结构

```
scripts/
  run.mjs          主入口：参数 → 数据 → 推荐 → 核价 → 记忆 → 输出合同
  recommend.mjs    推荐引擎：餐次/目的 + 约束过滤 + 偏好排序 + 抽签 + 理由
  preference.mjs   偏好映射：天气/星座 → 软偏好信号（含冲突提示）
  memory.mjs       历史与反馈读写（原子写入，失败降级）
  mcp.mjs          麦当劳 MCP 业务层：工具封装 + 菜单归一化 + 候选 + 核价
  verify-mcp.mjs   真实 MCP 端到端联调自检
  test.mjs         回归测试（离线可跑）
references/
  recommendation-rules.md  餐次/目的、打分、抽签、无解
  mcd-tools.md             MCP 工具清单与实测字段
  memory-schema.md         记忆存储结构
  output-contract.md       输出 JSON 合同
  acceptance.md            验收对照
```

## 自测

```bash
cd scripts && node test.mjs
# PASS: 预算 / 忌口 / 冷热 / 无解 / 明确排除 / 重抽避重复 / 星座 / 天气 / 偏好合成 / 归一化 / 餐次 / 用餐目的 / 价格未知 / 记忆

# 真实 MCP 端到端（需 Token）
MCD_MCP_TOKEN=xxx node verify-mcp.mjs --city 上海 --budget 30
```

## 麦当劳 MCP 工具映射

| 场景 | Tool |
| --- | --- |
| 附近门店 | `query-nearby-stores` |
| 菜单 | `query-meals` |
| 套餐详情/替换 | `query-meal-detail` |
| 门店优惠券 | `query-store-coupons` |
| 我的券 | `query-my-coupons` |
| 麦麦省券 | `available-coupons` / `auto-bind-coupons` |
| 精算价格 | `calculate-price` |
| 活动日历 | `campaign-calendar` |

接口字段事实见 `references/mcd-tools.md`。

## 边界与免责

- 本 Skill 为独立创意作品，**非麦当劳官方产品**，不暗示官方背书
- 输出为推荐与估算，餐品、价格、供应以麦当劳官方渠道实时结果为准
- 不预测运势：星座仅作口味倾向的趣味因子，不做吉凶/健康/财富预测
- 不提供营养/医疗建议，不作过敏安全保证
- 不创建订单、不支付、不消耗积分
