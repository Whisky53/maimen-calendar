---
name: maimen-calendar
description: 麦门日历 · 预算内帮你选，价格帮你核，吃过帮你记，到点提醒你。接入中国天气网实时天气与预报，按温度分层给出饮食建议；读取麦当劳真实活动日历与门店优惠券算出每天的活动力度；接入官方营养表做热量摄入计算并与训练计划平衡；生成分餐次的吃饭提醒与训练提醒，导出 .ics 或提供订阅链接。当用户说"今天吃什么""最近哪几天麦当劳划算""帮我排个吃饭提醒""把麦当劳活动同步到日历""算下这餐多少卡""安排训练计划"时使用。
---

# 麦门日历 · 从想吃到提醒的闭环

把「天气 → 活动力度 → 吃什么 → 热量 → 训练 → 日历」串成一条闭环。
核心一句话：**预算内帮你选，价格帮你核，吃过帮你记，到点提醒你。**

## 职责

在用户给定的城市、预算、餐次与训练目标下，产出一份**可导入日历的日程**，并说清每天为什么这样安排。

## 必要输入

- **城市**（可选，默认上海）
- **预算**（可选，默认 35 元，硬上限）
- **要提醒的餐次**（可选，默认 lunch）
- 训练模板 / 体重身高年龄（可选，用于训练与热量）
- 营养目标（可选，`--goal` 数值 kcal）

## 正常执行步骤

1. 取天气（中国天气网）→ 转成偏好信号
2. 取活动日历与门店券 → 算每日力度分
3. 组装当日候选 → 预算内筛选（硬上限，不回退）
4. 计算热量与训练消耗 → 有则给收支，缺则保留 unknown
5. 按餐次生成提醒项（按已保存的提醒设置过滤）→ 加活动日事件
6. 合并同日事件 → 导出 .ics 或启动订阅服务

## 硬约束（不可违背）

- **只提醒，绝不自动下单**：不调用 `create-order`，不支付、不扣积分、不自动领券
- **预算为硬上限**：任何活动力度都不放大预算
- **不做健康结论**：热量与消耗均为估算，不做医疗/营养诊断。单餐热量缺失时保留 unknown，**不输出全天收支结论**
- **力度是估算**：不是官方优惠金额，输出必须注明
- **UID 不含序号**：用稳定业务标识，见 `references/calendar-rules.md`
- **数据来源可追溯**：说明来自「中国天气网」/「麦当劳 MCP」/「本地默认」
- **不假称后台能力**：交付方式必须列明「可承诺 / 不可承诺」，见下方「交付状态」
- **「周一至周五」≠ 法定工作日**：调休与节假日需可靠来源或用户自定义，本工具不做假定

## 交付状态（§8.2）

提醒交付时必须如实说明能力边界，**不以文本承诺替代后台能力**：

| 交付方式 | 可承诺 | 不可承诺 |
| --- | --- | --- |
| ICS 文件 | 文件已生成，含事件与提醒设置 | 已添加进你的日历；一定会弹窗提醒 |
| 日历订阅 | 订阅地址可用，内容可更新 | 所有客户端实时刷新；秒级撤销 |
| 宿主调度工具 | 工具确认已创建定时任务 | 不具备后台能力时关闭应用也会运行 |

## 关键异常

| 情况 | 处理 |
| --- | --- |
| MCP 无 Token | 降级：天气仍可用，活动/营养标记为不可用，不伪装 |
| 预算内无正餐候选 | 明确返回无解，**不回退全菜单** |
| 单餐热量缺失 | 保留 unknown，不按 0 算，不给全天结论 |
| 同一餐次重复导出 | UID 不变 + SEQUENCE 递增，客户端识别为更新而非新增 |
| 餐次被提醒设置关闭/暂停/跳过 | 该餐次不生成日程，并在输出中说明原因 |

## 输出规则

- 面向用户：一句话结论 + 理由 + 日历入口，不倾倒原始 JSON
- 程序输出：`--json` 输出结构化合同；每条数据对象带来源状态（`source`/`status`/`scope`）
- 金额统一用整数分，展示转元两位小数

## 按需引用

- `references/calendar-rules.md` — 天气分层、力度评分、UID 规则、热量与训练
- `references/data-sources.md` — 各数据源实测记录与字段事实
- `../shared/` — MCP 传输层、金额、来源状态

<!-- 以下为工程实现说明，供维护者参考，不作为 Skill 执行指令 -->

## 快速开始

```bash
cd scripts

# 今日建议（天气 + 活动力度 + 预算 + 推荐）
node cli.mjs --city 上海 --budget 40

# 未来 7 天规划 + 导出日历文件
node cli.mjs --city 上海 --budget 40 --days 7 --ics ./maimen.ics

# 三餐都提醒
node cli.mjs --city 上海 --slots breakfast,lunch,dinner --days 7 --ics ./maimen.ics

# 设置提醒（持久化到 ~/.maimen/reminders.json，各餐次独立开关）
node cli.mjs --setup-reminders --slots breakfast,lunch --remind-lunch 11:45
node cli.mjs --slot-config dinner --disable
node cli.mjs --slot-config lunch --repeat weekdays
node cli.mjs --pause --until 2026-10-07
node cli.mjs --view-reminders

# 加训练计划 + 热量目标
node cli.mjs --city 北京 --budget 45 --training fatLoss --weight 58 --goal 1600

# 启动订阅服务
MCD_MCP_TOKEN=xxx node serve.mjs --city 上海 --budget 40 --training fatLoss --port 8899

# 离线演示 / 回归测试
node cli.mjs --demo --city 上海
node test.mjs
```

## 参数

| 参数 | 取值 | 默认 |
| --- | --- | --- |
| `--city` | 城市名或 9 位城市码 | 上海 |
| `--budget` | 元（硬上限） | 35 |
| `--days` | 规划天数 | 7 |
| `--slots` | `breakfast,lunch,dinner,late-night,snack`（逗号分隔） | lunch |
| `--remind-<slot>` | 该餐次提醒时间 HH:MM | 见规则文件 |
| `--store` | 门店 storeCode（跳过查询） | 无 |
| `--training` | `fatLoss` / `muscle` / `maintain` | 无 |
| `--goal` | 每日热量目标 kcal（数值） | 按 TDEE |
| `--weight` / `--height` / `--age` / `--gender` | 训练与热量估算 | 60 / 168 / 30 / female |
| `--ics` | 导出路径 | 无 |
| `--json` / `--demo` | 输出 JSON / 强制离线 | 关 |

### 提醒设置子命令

| 参数 | 说明 |
| --- | --- |
| `--setup-reminders` | 首次设置（配 `--slots` / `--remind-<slot>`） |
| `--view-reminders` | 查看当前设置 |
| `--slot-config <餐次>` | 修改某餐次（`--enable` / `--disable` / `--slot-budget` / `--repeat` / `--repeat-days`） |
| `--pause [--until <日期>]` | 暂停全天 |
| `--resume` | 恢复 |
| `--skip-day <日期> [--slot <餐次>]` | 跳过某天 |
| `--snooze <餐次> [--minutes <N>]` | 延后本次（默认 30 分钟） |

> ⚠️ `--training` 与 `--goal` 语义不同，不可混用；写错直接报错退出。

## 环境变量

| 变量 | 用途 | 必填 |
| --- | --- | --- |
| `MCD_MCP_TOKEN` | 麦当劳 MCP Token | 否（缺省降级，天气仍可用） |
| `MCD_MCP_URL` | MCP 接入地址 | 否（默认 `https://mcp.mcd.cn`） |
| `MAIMEN_REMINDERS_PATH` | 提醒设置文件路径 | 否（默认 `~/.maimen/reminders.json`） |

> **Token 安全**：只通过环境变量注入，绝不写入源码、仓库、示例或日志。

## 日历接入

| 方式 | 命令 | 导入 |
| --- | --- | --- |
| 导出文件 | `--ics ./maimen.ics` | 双击导入苹果/谷歌/Outlook/系统日历 |
| 订阅链接 | `node serve.mjs --port 8899` | 苹果 `webcal://127.0.0.1:8899/maimen.ics`；谷歌需公网 |

刷新间隔默认 6 小时，用 `--refresh <分钟>` 调整。

## 已收录城市

北京、上海、广州、深圳、杭州、成都、武汉、南京、西安、重庆、天津、苏州、长沙、郑州、青岛。
其他城市可传 9 位城市码（`--city 101020100`）。

## 自测

```bash
cd scripts && node test.mjs
# ✅ 通过 97/97
```

## 边界与免责

- 本 Skill 为**独立创意作品**，非麦当劳官方产品，不暗示官方背书
- 活动力度、热量、训练消耗均为**估算**，实际以官方渠道为准
- **不创建订单、不支付、不消耗积分、不自动领券**
