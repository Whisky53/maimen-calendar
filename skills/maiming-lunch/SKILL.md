---
name: maiming-lunch
description: 麦命打工人 · 午间补给站。按预算、冷热偏好、忌口，结合今日天气与星座倾向，从麦当劳菜单中推荐一套午饭，并给出可解释理由；接入麦当劳 MCP 时可查真实菜单、优惠券并精算最优惠价格。当用户说"中午吃什么""帮我选午饭""预算内推荐麦当劳""今天天气适合吃啥""算一下哪个套餐最便宜"时使用。
---

# 麦命打工人 · 午间补给站

给上班族的午饭决策助手。核心目标一句话：**上班已经够难了，午饭别再做选择题。**

## 何时使用本 Skill

- 用户纠结"中午吃什么"，想要一套现成建议。
- 用户给出预算（如"25 块以内的午饭"）希望在此范围内推荐。
- 用户提到天气 / 星座 / 口味偏好，希望据此推荐。
- 用户想比较麦当劳套餐价格、找到最优惠的一单。

## 能力范围

| 能力 | 说明 | 状态 |
| --- | --- | --- |
| 套餐推荐引擎 | 硬约束（预算/忌口/明确排除）过滤 → 软偏好排序 → 最优档抽签 | ✅ 已实现并自测 |
| 天气 → 偏好映射 | 温度/降水转成冷热、暖胃倾向 | ✅ 已实现并自测 |
| 星座 → 偏好映射 | 生日 → 星座 → 元素 → 口味倾向（趣味因子，弱权重） | ✅ 已实现并自测 |
| 真实菜单与优惠 | 查门店、真实菜单、可用优惠券 | ✅ **已对真实 MCP 联调通过** |
| 最优惠价格精算 | 调 `calculate-price` 核验应付金额并比价 | ✅ **已对真实 MCP 联调通过** |
| 记录与反馈记忆 | 存档选择、反馈影响下次推荐 | ✅ 引擎侧已支持（持久化依赖调用方） |

> **联调实况（2026-10-10）**：使用真实 Token 打通「查门店 → 查真实菜单（97 项）→ 硬约束筛选 → 服务端精算比价」全链路。
> 例：门店 `1400685`，比价得「我就喜欢鸡薯双全盒 ¥31.00 / 酥脆无双套餐 ¥31.00 / 枫糖厚松饼猪柳堡三件套 ¥39.00」，与官网价格一致。

## 设计原则（不可违背）

1. **硬约束优先**：预算、忌口、明确排除永不被软偏好或随机性突破。
2. **可解释**：每条推荐理由都能追溯到具体规则或数据来源。
3. **不预测运势**：星座仅作口味倾向的趣味因子，不做吉凶、健康、财富预测。
4. **不下单不付款**：本 Skill 只做推荐与算价，不创建订单、不扣积分、不支付。
5. **演示与真实分明**：无 Token 时用内置演示数据，输出必须标注"演示"。

## 快速开始

```bash
cd scripts

# 1) 基础推荐（离线演示数据）
node run.mjs --budget 30 --drink hot --no-spicy

# 2) 结合天气与星座
node run.mjs --budget 30 --weather '{"tempC":5,"precipitation":"rain"}' --birthday 2000-08-15

# 3) JSON 输出（供程序消费）
node run.mjs --budget 25 --json

# 4) 接入真实 MCP（查真实门店 + 菜单 + 精算比价）
export MCD_MCP_TOKEN=你的token
node run.mjs --budget 40 --city 上海 --weather '{"tempC":32}'

# 5) 完整端到端联调自检（只询价，不下单）
MCD_MCP_TOKEN=你的token node verify-mcp.mjs --city 上海 --budget 30
```

## 参数说明

| 参数 | 取值 | 默认 |
| --- | --- | --- |
| `--budget` | 元（整数） | 30 |
| `--drink` | `any` / `hot` / `cold` | any |
| `--no-spicy` | 开关 | 关 |
| `--city` | 城市名（真实 MCP 时用于查门店） | 上海 |
| `--birthday` | `YYYY-MM-DD` | 无 |
| `--weather` | JSON 或 `"温度,降水"` | 无 |
| `--store` | 真实门店 storeCode（纯数字，跳过门店查询） | 无 |
| `--json` | 输出 JSON | 关 |
| `--demo` | 强制演示数据 | 关 |
| `--zodiacs` | 列出支持星座 | - |

## 环境变量

| 变量 | 用途 | 必填 |
| --- | --- | --- |
| `MCD_MCP_TOKEN` | 麦当劳 MCP Token | 否（缺省走演示数据） |
| `MCD_MCP_URL` | MCP 接入地址 | 否（默认 `https://mcp.mcd.cn`） |

> ⚠️ **Token 安全**：Token 只能通过环境变量注入，**绝不写入源码、仓库、配置示例或日志**。参赛提交时 `mcp-config.example.json` 只允许环境变量占位符。

## 输出示例（真实 MCP）

```
🍟 麦命打工人 · 今日午饭建议
────────────────────────────────────────────
数据来源：mcp
门店：麦当劳（某交通枢纽店，storeCode 1400685）
预算结界：¥40.00 · 冷热：any · 不限辣
偏好信号：
  · 32°C 天热，优先冰饮清爽路线
  · 水瓶座（air象）：随性派不挑温度，看当天心情
────────────────────────────────────────────
💱 真实比价（服务端精算）：
   “我就喜欢”鸡薯双全盒：¥31.00 ⭐最省
   枫糖风味厚松饼猪柳堡三件套：¥39.00
   酥脆无双套餐：¥31.00
────────────────────────────────────────────
👉 酥脆无双套餐
   标价：¥31.00（符合条件共 3 套）
   理由：
     · 预算内，还剩 ¥9.00
     · 服务端实付精算 ¥31.00
     · 在候选方案里已是实付最低的一档
────────────────────────────────────────────
非官方应用 · 只询价不下单不付款 · 价格以麦当劳官方渠道为准
```

## 模块结构

```
scripts/
  run.mjs          主入口：解析参数 → 取数据（真实/演示）→ 推荐 → 输出
  recommend.mjs    推荐引擎：约束过滤 + 偏好排序 + 抽签 + 理由生成
  preference.mjs   偏好映射：天气/星座 → 软偏好信号（含冲突提示）
  mcp.mjs          麦当劳 MCP 适配层：工具调用 + 菜单归一化 + 比价
  verify-mcp.mjs   真实 MCP 端到端联调自检（门店→菜单→比价）
  test.mjs         回归测试：硬约束/边界/星座/归一化
references/
  mcd-tools.md     麦当劳 MCP 工具清单与本 Skill 的用法对照（含实测字段）
  acceptance.md    参赛验收对照（CT/AC/PV）
mcp-config.example.json  脱敏的 MCP 配置示例（仅环境变量占位符）
```

## 自测

```bash
cd scripts && node test.mjs
# PASS: 预算 / 忌口 / 冷热 / 无解 / 明确排除 / 重抽避重复 / 星座 / 天气 / 偏好合成 / 归一化

# 真实 MCP 端到端（需 Token）
MCD_MCP_TOKEN=xxx node verify-mcp.mjs --city 上海 --budget 30
```

## 真实 MCP 接口事实（已实测，勿凭猜测改动）

| 事实 | 正确做法 |
| --- | --- |
| 商品字段名 | `items` 用 **`productCode`**（不是 `code`），`quantity` 为整数 |
| 价格单位 | `calculate-price` 返回 **分**（`price`/`originalPrice`/`discount`）；`query-meals` 的 `currentPrice` 是**元字符串** |
| 必填上下文 | `query-meals` / `calculate-price` 都必填 `storeCode` + `beType` + `orderType`（到店自取：1/1） |
| 门店获取 | `query-nearby-stores` 需 `beType` + `searchType`，加 `city` 或 `keyword` |
| 菜单结构 | `data.categories[]`（含 code 列表）+ `data.meals{}`（code → 详情映射表） |
| 响应位置 | 同时存在 `result.content[0].text` 与 `result.structuredContent`，优先取后者 |
| 业务失败 | `structuredContent.success === false` 时带 `code` / `message` |

## 麦当劳 MCP 工具映射

真实接入时使用以下官方 Tool（详见 `references/mcd-tools.md`）：

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

## 边界与免责

- 本 Skill 为独立创意作品，**非麦当劳官方产品**，不暗示官方背书。
- 输出为推荐与估算，餐品、价格、供应以麦当劳官方渠道实时结果为准。
- 不提供营养/医疗建议，不作过敏安全保证。
- 不创建订单、不支付、不消耗积分。
