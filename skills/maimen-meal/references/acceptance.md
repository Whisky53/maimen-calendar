# 验收对照（maimen-meal）

对应《麦门日历-SKILL需求说明书 V1.1》第 14 节与官方大赛规则。

> **记录口径（需求说明书 §13.2 P1）**：本文件严格区分三类陈述，不混列——
> - **支持能力**：代码里确实实现的功能
> - **调用证据**：真实调用过并留下记录的事实，附时间
> - **当前验证状态**：今天重新跑过的结果

---

## 一、支持能力（代码实现）

| 能力 | 实现位置 | 状态 |
| --- | --- | --- |
| 餐次 / 用餐目的识别 | `recommend.mjs` `inferSlot` / `MEAL_SLOTS` / `MEAL_PURPOSES` | 已实现 |
| 预算硬上限（无倍数放宽） | `recommend.mjs` 硬约束段 | 已实现 |
| 价格未知保留 null | `mcp.mjs` `normalizeMenu`、`recommend.mjs` `normalizeMeal` | 已实现 |
| 候选不足不回退全菜单 | `mcp.mjs` `buildCandidates` | 已实现 |
| 服务端核价（最多 6 套候选，实付价复核预算） | `mcp.mjs` `comparePrices` | 已实现 |
| 核价失败按对象标记来源 | `comparePrices` 返回 `status` | 已实现 |
| 持久化事件流（七类事件） | `memory.mjs` `EVENT_TYPES` / `makeEvent` | 已实现 |
| 事件幂等（同 eventId 不重复写） | `memory.mjs` `appendEvent` / `deterministicId` | 已实现 |
| v1 → v2 迁移（数据不丢失） | `memory.mjs` `migrate` | 已实现 |
| 确认偏好 vs 推断偏好分离 | `memory.mjs` `confirmed` / `inferred` | 已实现 |
| 保留期（180 天）与窗口（30 天） | `memory.mjs` `purgeExpired` / `deriveMemory` | 已实现 |
| 同餐次优先 + 跨餐次弱信号 | `memory.mjs` `crossSlotPenalty` | 已实现 |
| 趋势口径（consumed 才算消费） | `memory.mjs` `trendReport` | 已实现 |
| 查看 / 撤销 / 导出 / 清空 | `run.mjs` 记忆子命令 | 已实现 |
| 明确偏好 CLI 入口 | `run.mjs` `--confirm-*` / `--unconfirm` | 已实现 |
| 业务无解 / 服务失败区分 | `run.mjs` `dataStatus` | 已实现 |
| 输出合同十段式 | `run.mjs` `payload` | 已实现 |
| 来源状态五态 | `../shared/source-status.mjs` | 已实现 |
| 门店不默认第一项为最近 | `run.mjs` 标注「候选首项，需用户确认」 | 已实现 |

---

## 二、调用证据（真实调用过，附时间）

| 时间 | Tool | 结果 |
| --- | --- | --- |
| 2026-10-10 | `initialize` | 服务端 `mcd-mcp v1.0.0`，协议 2024-11-05 |
| 2026-10-10 | `tools/list` | 返回 35 个 Tool |
| 2026-10-10 | `query-nearby-stores` | 取到实测门店（storeCode 已脱敏） |
| 2026-10-10 | `query-meals` | 13 分类 / 97 个真实餐品，价格与官网一致 |
| 2026-10-10 | `calculate-price` | 3 档候选精算，与官网价格一致 |

> 说明：以上为**当时的调用证据**，不表示当前环境仍有 Token。当前验证状态见下一节。

---

## 三、当前验证状态（本次改造后重跑）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 回归测试（meal） | `node test.mjs` | ✅ 全通过（39 组，含事件流 v2 / 幂等 / 迁移 / 保留期 / 确认vs推断 / 趋势口径） |
| 回归测试（calendar） | `node test.mjs` | ✅ 通过 97/97（含提醒设置 9 组、事件合并 5 组、交付状态 2 组） |
| 演示模式端到端 | `node run.mjs --demo --slot lunch --json` | ✅ 输出合同结构完整 |
| 记忆事件流 | `--feedback like` → `--record consumed` | ✅ 事件正确记录，幂等生效（第二次输出「已存在，未重复写入」） |
| v1 → v2 迁移 | 构造 v1 存储后读写 | ✅ 4 条事件完整迁移，dislike 正确迁入 `confirmed.dislikes` |
| 记忆两档清空 | `--clear-keep-confirmed` / `--clear` | ✅ 前者保留明确忌口，后者全清 |
| 明确偏好 CLI | `--confirm-allergy` / `--confirm-ban` / `--unconfirm` | ✅ 写入 `preference_updated` 事件，`confirmed` 同步更新 |
| 趋势样本保护 | 仅 1 次选择记录 | ✅ 输出「样本不足 3 次，暂不报告趋势」 |
| 提醒设置子命令 | `--setup-reminders` / `--slot-config` / `--pause` / `--resume` / `--skip-day` / `--snooze` / `--view-reminders` | ✅ 全部生效，设置持久化 |
| 提醒过滤日程 | 关闭 breakfast、lunch 设周一到周五 | ✅ breakfast 0 条、lunch 8 天中只出 5 条（正确排除周末） |
| ICS 严格解析 | `ical.js` 解析导出文件 | ✅ RFC 5545 合规：15 VEVENT / 15 唯一 UID / 无超 75 字节行 / CRLF |
| ICS 取消语义 | `STATUS:CANCELLED` | ✅ 取消事件不带 VALARM |
| 真实 MCP 端到端 | `node verify-mcp.mjs` | 需 Token，未在本环境重跑 |

---

## 四、功能验收（AC）

### 本轮新增覆盖

| 编号 | 场景 | 行为 | 状态 |
| --- | --- | --- | --- |
| AC-29 | 命名迁移 | 目录/frontmatter/引用统一为 `maimen-meal` | ✅ |
| AC-30 | 四餐次路由 | `--slot` 支持五值，按时间推断 | ✅ 测试覆盖 |
| AC-31 | 供应边界 | 候选为空返回无解，不回退 | ✅ 测试覆盖 |
| AC-32 | 仅咖啡场景 | `--purpose drink-only` 只出带饮品候选 | ✅ 测试覆盖 |
| AC-33 | 分餐次预算 | 预算按餐次传入，硬上限 | ✅ 测试覆盖 |
| AC-34 | 同日分餐次共存 | 早/晚餐 UID 不同，不同餐次不合并 | ✅ 测试覆盖 |
| AC-36 | 同餐次学习 | 记忆按 slot 隔离，跨餐次作弱信号 | ✅ 测试覆盖 |

### 第二阶段新增覆盖（形成使用闭环）

| 编号 | 场景 | 行为 | 状态 |
| --- | --- | --- | --- |
| AC-37 | 事件幂等 | 同一动作重试不重复写入 | ✅ 测试覆盖 |
| AC-38 | Schema 迁移 | v1 → v2 数据不丢失，dislike 迁入 confirmed | ✅ 测试覆盖 |
| AC-39 | 确认 vs 推断 | `confirmed` 不被 `inferred` 覆盖，推断不升级为禁忌 | ✅ 测试覆盖 |
| AC-40 | 保留期与窗口 | 超 180 天清理；窗口外不参与推荐但保留 | ✅ 测试覆盖 |
| AC-41 | 清空派生偏好 | 清空历史时推断偏好一并清除，明确确认默认保留 | ✅ 测试覆盖 |
| AC-42 | 趋势口径 | 只有 `consumed` 才称「实际消费」；样本不足不报告 | ✅ 测试覆盖 |
| AC-43 | 分餐次提醒开关 | 各餐次独立开关、时间、重复规则，持久化 | ✅ 测试覆盖 |
| AC-44 | 工作日语义 | 「周一至周五」明示不等于法定工作日 | ✅ 测试覆盖 |
| AC-45 | ICS 更新语义 | 稳定 UID + SEQUENCE + LAST-MODIFIED；取消事件带 CANCELLED | ✅ 测试覆盖 + ical.js 校验 |
| AC-46 | ICS 事件合并 | 同日活动并入用餐事件；不同餐次绝不合并；重复刷新不重复 | ✅ 测试覆盖 |
| AC-47 | 交付状态说明 | 三种交付方式各自列明「可承诺 / 不可承诺」 | ✅ 测试覆盖 |

### 延续覆盖

| 编号 | 场景 | 行为 | 状态 |
| --- | --- | --- | --- |
| AC-01 | 首次无历史 | 只用设置/天气/菜单推荐，不虚构偏好 | ✅ |
| AC-02 | 全部超预算 | 不输出超预算方案，提示无解 + 原因 | ✅ |
| AC-03 | 指定不喝碳酸 | 过滤对应组合 | ✅ |
| AC-07 | 连续重抽 | 重抽不自动记为负面偏好 | ✅ |
| AC-08 | 长期不再推荐 | `dislike` 集合硬过滤 | ✅ |
| AC-16 | 无真实 Token | 源码/示例无凭证，仅环境变量 | ✅ |
| AC-17 | 不创建订单 | Skill 不含任何下单调用 | ✅ |

---

## 五、内部验证（PV）

| 编号 | 要求 | 证据 |
| --- | --- | --- |
| PV-01 | 真实接入闭环 | 见第二节调用证据（2026-10-10） |
| PV-03 | 文档一致性 | SKILL.md 只列已实现能力，细节移入 `references/` |
| PV-04 | 凭证与隐私 | Token 仅环境变量；错误信息不回显 Token |
| PV-05 | 趣味文案 | 星座仅作口味倾向，明确「非运势预测」 |

---

## 六、代码自测

```bash
cd scripts && node test.mjs
```

覆盖：预算 / 忌口 / 冷热 / 无解 / 明确排除 / 重抽避重复 / 星座 / 天气 /
偏好合成 / 归一化 / 餐次 / 用餐目的 / 价格未知 / 记忆 + 事件流v2 / 幂等 /
迁移 / 保留期 / 确认vs推断 / 趋势口径

`maimen-calendar`：

```bash
cd ../maimen-calendar/scripts && node test.mjs
```

覆盖：城市码 / 天气分层 / 力度评分 / 内容型不误判 / 券加成 / 热量收支 /
训练展开 / ICS 规范 / UID 稳定性 / 事件合并 / 交付状态 / 提醒设置

---

## 七、未达标项（诚实记录）

| 项 | 说明 |
| --- | --- |
| 优惠券叠加核价 | `query-store-coupons` / `auto-bind-coupons` 尚未接入核价链路，当前核价调用 calculate-price，但未主动枚举券组合 |
| 订单 / 支付 | 项目明确不做，属设计边界而非缺陷 |
| 真实 MCP 当前状态 | 本环境无 Token，未重跑 `verify-mcp.mjs`；上一次证据时间为 2026-10-10 |
