# 麦门日历 · 麦当劳活动日历与全餐次规划助手
![Uploading image.png…]()

> 今天有什么活动？这一餐怎么选？预算够不够？—— 一个 Skill 全替你算好。

「麦门日历」是一个基于**麦当劳官方 MCP Server** 的 WorkBuddy Skill，把
**天气 → 活动力度 → 吃什么 → 热量 → 训练 → 日历提醒** 串成一条闭环。
它不帮你下单，只帮你**看清什么时候吃最值、吃什么最合适**。

---

## 它解决什么问题

| 痛点 | 麦门日历给的答案 |
| --- | --- |
| 不知道今天麦当劳有没有活动 | 读取**真实活动日历**，每天算 0–100 分「活动力度」 |
| 不知道哪天最划算 | 挑出未来最值得吃的日子，并说明理由 |
| 不吃辣的、想喝冰的、预算 35 元 | 按硬约束过滤，再按天气/星座软偏好排序 |
| 想省钱但懒得比价 | 对最多 6 套符合条件的候选调用 `calculate-price`，按应付价再次检查预算 |
| 想知道这顿多少卡 | 接**麦当劳官方营养表**（160 条）算热量 |
| 想配合减脂/增肌 | 热量收支平衡 + 训练计划（MET 消耗估算） |
| 不想自己记提醒 | 导出 `.ics` 导入苹果/谷歌/Outlook 日历，或起本地订阅服务 |

---

## 核心能力

### 1. 真实活动力度评分（0–100）
读取 `campaign-calendar` 的当月活动，结合门店可用券，算出每天的"力度"。

**不是简单地数活动条数**——实测踩过坑：15 条"蘸酱上新"看着热闹，其实一分钱没省。
所以引擎区分两族关键词：
- **优惠型**（免单/买一送一/半价/X元套餐）→ 高权重
- **内容型**（上新/联名/周边/线下派对）→ 低权重且**封顶 15 分**

输出 5 档：🔥大力 ≥80 / ✨值得去 ≥60 / 🙂小惊喜 ≥35 / 💤平平 ≥18 / 😐无活动 <18

### 2. 天气分层规则
接入**中国天气网**（实时 + 今日预报 + 生活指数），按温度四层给出饮食倾向：

| 条件 | 阈值 | 影响 |
| --- | --- | --- |
| 严寒 | ≤5°C | 强烈建议热食热饮 |
| 偏凉 | 5–15°C | 优先热食热饮 |
| 舒适 | 15–28°C | 温度不限 |
| 偏热 | 28–35°C | 优先冰饮清爽 |
| 酷热 | ≥35°C | 强烈建议冰饮清爽 |

另含降水强弱、AQI 三档、风力、紫外线信号，并有**冲突消解**
（如「37°C + 暴雨」主导仍是冰饮，降水降级为备注）。

### 3. 热量与训练
- **热量**：麦当劳官方营养表（`list-nutrition-foods`，实测 160 条），含能量/蛋白/脂肪/碳水/钠/钙。
- **训练**：3 套模板（减脂/增肌/维持），按 MET 公式估算消耗，与摄入做**收支平衡**。
- **基础代谢**：Mifflin-St Jeor 公式估算每日目标摄入。

### 4. 日历提醒与导出
- **分餐次提醒**：每个餐次独立开关、时间与重复规则，持久化在 `~/.maimen/reminders.json`；
  支持修改、关闭、跳过当天、暂停全天、延后本次。
- 生成吃饭提醒 + 训练提醒，事件里明确写"请自行前往麦当劳官方渠道下单"。
- 导出标准 **iCalendar**（零依赖，严格 RFC 5545：CRLF 换行、75 字节折行、转义、时区、VALARM）。
- **稳定 UID + SEQUENCE**：同一事件重复导出是「更新」而非「新增」；
  同一天不同餐次 UID 不同可共存；同日活动信息合并进用餐事件描述。
- 可选启动本地订阅服务，用 `webcal://` 链接订阅到日历 App。

> **交付状态如实说明**：ICS 文件只保证「文件已生成」，不承诺「已加进你的日历」或「一定弹窗」；
> 订阅只保证「地址可用、内容可更新」，不承诺所有客户端实时刷新。
> 是否真正提醒取决于你所用客户端与宿主能力。

> ⚠️ 「周一至周五」**不等于法定工作日**。调休与节假日需可靠日历来源或用户自定义，本工具不做假定。

### 5. 记忆与偏好学习
- **七类事件**：展示 / 选择 / 吃过 / 换过 / 反馈 / 跳过 / 偏好更新，语义严格区分。
- **`selected` ≠ `consumed`**：选了不代表吃过，只有确认吃过才算「实际消费」。
- **确认优先于推断**：你明确说的忌口/过敏不会被统计推断覆盖，推断也不会升级成禁忌。
- **同餐次优先**：早餐的偏好不污染晚餐；但过敏与全局忌口跨餐次生效。
- **180 天保留 + 30 天窗口**：旧事件定期清理，窗口外不参与推荐但仍在本地。
- 可查看、撤销、导出、清空；清空历史时由历史派生的推断偏好一并清除。

---

## 安装与使用

### 前置条件
- Node.js 22+
- 麦当劳 MCP Token（在 [open.mcd.cn/mcp](https://open.mcd.cn/mcp) 手机号登录申请）

### 配置
把 Token 放进环境变量（**不要写进任何文件**）：
```sh
export MCD_MCP_TOKEN="你的Token"
```
或参考根目录 `mcp-config.example.json` 配置 MCP Server。

### 跑起来
```sh
# 麦门日历：吃 14 天的午饭提醒，导出 .ics
cd skills/maimen-calendar/scripts
MCD_MCP_TOKEN=xxx node cli.mjs \
  --city 上海 --days 14 --budget 35 \
  --weight 70 --height 175 --age 28 --gender male --training fatLoss \
  --ics ./麦门日历.ics

# 麦门这一餐：今天这一餐吃什么（按餐次 + 真实比价）
cd skills/maimen-meal/scripts
MCD_MCP_TOKEN=xxx node run.mjs --budget 35 --city 上海 --slot lunch

# 提醒设置（持久化到 ~/.maimen/reminders.json，各餐次独立开关）
node cli.mjs --setup-reminders --slots breakfast,lunch --remind-lunch 11:45
node cli.mjs --slot-config dinner --disable
node cli.mjs --pause --until 2026-10-07

# 记忆：反馈 / 记录 / 查看 / 清空
node run.mjs --record selected --record-id c
node run.mjs --feedback like --feedback-id c
node run.mjs --record consumed --record-id c
node run.mjs --view
node run.mjs --confirm-allergy 花生
node run.mjs --clear-keep-confirmed

# 只做端到端联调自检（询价，不下单）
MCD_MCP_TOKEN=xxx node verify-mcp.mjs
```

### 跑测试
```sh
# 麦门日历：97 项回归测试（离线，不需要 Token）
cd skills/maimen-calendar/scripts && node test.mjs

# 麦门这一餐：39 组回归测试（离线，不需要 Token）
cd skills/maimen-meal/scripts && node test.mjs
```

### 真实链路回归测试
```sh
node skills/maimen-meal/scripts/integration.test.mjs
```
使用隔离的模拟 MCP 传输验证完整 CLI：核价涨价、全部失败、异常金额、仅饮品、空候选，以及展示记录不等于选择记录。此测试不需要 Token，也不调用真实账号。

### 本地订阅服务
```sh
cd skills/maimen-calendar/scripts
MCD_MCP_TOKEN=xxx node serve.mjs --port 8787 --city 上海
# 浏览器打开 http://127.0.0.1:8787 看首页
# 日历订阅：webcal://127.0.0.1:8787/maimen.ics
```

---

## 真实运行案例

以下是**真实 MCP 联调**输出（非演示数据），2026-10-10 实测：

```
① 查门店  query-nearby-stores
   门店：麦当劳（某交通枢纽店，storeCode 1400685）
   storeCode：1400685

② 查真实菜单  query-meals
   真实餐品数：97（主食 43 / 饮品 20 / 小食 34）

③ 组装 3 套候选套餐 → ④ 真实比价 calculate-price（服务端精算）
   A · 不素之霸双层牛堡 + 纯悦        ¥38.50
   B · 麦香鱼 + 中杯怡泉+C            ¥38.50
   C · 牛肉堡精选 + 冰燕麦奶铁 + 饼干  ¥44.50
```

活动力度评分真实输出（2026-10-10 的 12 天日历）：
```
2026-10-10   80 🔥大力    韩式风味蘸酱上新
2026-10-22   22 💤平平    第三周周边即将开售
2026-10-12    5 😐无活动  蓝莓爆爆珠麦旋风上新
```

> 说明：评分是**启发式估算**，不是官方优惠金额；实际优惠以麦当劳官方渠道为准。

---

## 目标用户

- **写字楼打工人**：中午不知道吃什么，想少花钱又不想吃太差。
- **健身人群**：想在快餐里控制热量，需要"这顿多少卡"的即时反馈。
- **麦当劳活动党**：想第一时间知道哪天有大活动、哪天值得去吃。
- **日程控**：想把吃饭/训练计划同步进手机日历，被提醒而非自己记。

---

## 用了哪些 MCP Tool

本项目使用麦当劳 MCP 的 10 个 Tool，详见 [`MCP_INTEGRATION.md`](./MCP_INTEGRATION.md)：

`query-nearby-stores` · `query-meals` · `query-meal-detail` · `calculate-price` ·
`query-store-coupons` · `query-my-coupons` · `available-coupons` · `auto-bind-coupons` ·
`campaign-calendar` · `list-nutrition-foods`

天气数据来自**中国天气网**（MCP 无天气能力，自行接入）。

---

## 项目结构

```
maimen-calendar/
├── README.md                    # 本文件
├── CONTEST_DECLARATION.md       # 参赛声明（官方模板）
├── MCP_INTEGRATION.md           # MCP 集成说明
├── workbuddy.md                 # WorkBuddy 使用说明
├── mcp-config.example.json      # MCP 配置示例（环境变量占位符）
├── .gitignore                   # 确保 Token 不入库
└── skills/
    ├── shared/                  # 两个 Skill 共用：MCP 传输层 / 金额 / 来源状态
    │   ├── mcp-client.mjs
    │   ├── money.mjs
    │   └── source-status.mjs
    ├── maimen-calendar/         # 主 Skill：活动力度 + 天气 + 热量 + 训练 + 日历
    │   ├── SKILL.md
    │   ├── references/
    │   │   ├── calendar-rules.md
    │   │   └── data-sources.md
    │   └── scripts/
    │       ├── cli.mjs          # 主入口（含提醒设置子命令）
    │       ├── weather.mjs      # 中国天气网适配 + 温度分层
    │       ├── campaign.mjs     # 活动力度评分引擎
    │       ├── nutrition.mjs    # 热量 + 训练
    │       ├── ics.mjs          # RFC 5545 日历生成 + 事件合并 + 交付状态
    │       ├── reminders.mjs    # 分餐次提醒设置（持久化）
    │       ├── mcd.mjs          # 麦当劳 MCP 业务封装
    │       ├── serve.mjs        # 本地订阅服务
    │       └── test.mjs         # 回归测试
    └── maimen-meal/             # 配套 Skill：单餐推荐 + 真实比价
        ├── SKILL.md
        ├── references/
        │   ├── recommendation-rules.md
        │   ├── mcd-tools.md
        │   ├── memory-schema.md
        │   ├── output-contract.md
        │   └── acceptance.md
        └── scripts/             # run.mjs / memory.mjs / recommend.mjs / mcp.mjs / test.mjs
```

---

## 本次优化的行为边界

- 推荐输出只记录「展示」，用 `--record selected` 或 `--record consumed` 明确确认后才记录选择或吃过。
- 真实请求失败、空菜单、核价失败时不回退到演示套餐。未配置 Token 或指定 `--demo` 仍可演示，结果明确标注。
- 实付金额必须是正整数分；异常零元需到官方渠道确认。核价超预算的候选不会被推荐。
- 最低价仅指本次已核价且符合约束的候选；菜单初筛和最多 6 套的核价上限意味着不保证全店或所有优惠组合的最低价。个性化推荐可以与本次最低价候选不同。
- `drink-only` 只推荐饮品，明确冷热要求不把温度未知当成符合。
- MCP 请求 15 秒超时，不自动重试领券等写操作。

## 设计原则

1. **真实优先**：所有菜单、价格、活动、营养均来自麦当劳 MCP 实测，不编造数据。
2. **只提醒不下单**：零资金风险，明确告知用户自行前往官方渠道。
3. **力度是估算**：评分是启发式规则，输出必须注明"力度为估算"。
4. **硬约束优先**：预算、忌口不被天气/活动力度突破。
5. **数据可追溯**：每条输出都能说明来自「中国天气网」还是「麦当劳 MCP」。
6. **不假称能力**：数据缺失保留 `unknown`，交付方式如实说明可承诺与不可承诺。
7. **确认优先于推断**：用户明确说的不被统计推断覆盖，推断也不升级为禁忌。

---

## 边界与免责

- 本工具为**非官方应用**，与麦当劳官方无隶属关系。
- 活动力度评分为**估算**，实际优惠以麦当劳官方渠道为准。
- 热量数据以麦当劳官方营养表为准，训练消耗为 MET 公式估算，仅供参考。
- **不提供下单、支付功能**，所有消费请自行前往麦当劳官方渠道。

---

## License

MIT
