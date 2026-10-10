---
name: maimen-meal
description: 按预算、冷热偏好和历史反馈推荐麦当劳早餐、午餐、晚餐、夜宵或加餐；查询门店菜单，核验候选应付价格，记录用户明确选择与吃过。用于“这一餐吃什么”“预算内选套餐”“比较这几套价格”；多日活动与提醒规划交给 maimen-calendar。
---

# 麦门这一餐

上班已经够难了，吃饭别再做选择题。保留轻松的打工人文案，事实、价格与约束先于趣味表达。

## 执行

1. 读取预算、城市或门店、餐次、目的及明确偏好。预算默认 30 元；餐次可自动推断，用户明确指定优先。目的支持正餐、轻食、仅饮品。
2. 读取同餐次的历史与反馈。查看明确忌口与过敏信息；名称推断不能证明不含过敏原，成分未核验时不作安全保证。
3. 有 Token 时查询门店与当前菜单。收藏/候选首项不代表最近门店，显示名称与地址，用户指定门店使用其 storeCode。
4. 按菜单标价初筛与用餐目的组装候选，再过滤明确冷热、辣味与排除项。空候选即无解。
5. 调用 scripts/live-recommend.mjs：对最多 6 套候选询价，使用官方应付价再次检查预算，再按偏好与近期记录排序、抽签。comparison.best 是本次成功核价且符合约束的最低价；个性化推荐可以不同。
6. 输出推荐、应付金额、理由、比较范围及失败项。展示只写 recommendation_shown；用户明确选定才写 selected，确认吃过才写 consumed。

## 事实边界

- 真实模式不得把失败或空结果替换为演示套餐。无 Token 或显式 --demo 才可演示，并明确标注。
- 金额内部用整数分；缺失、负值、非整数及异常零元报价不作为已核验金额。核价失败候选保留失败状态，不用菜单价冒充实付价。
- 最低价只覆盖本次核价候选；未穷举全店、个人券、会员价或所有券组合，不宣称全局最优。脚本没有自动领券。
- 当前菜单只代表本次门店查询，不证明未来早餐/夜宵时段可售，也不保证持续有货。
- “仅饮品”不推荐整套正餐；明确冷热要求不把温度未知当成满足。辣味为名称规则，不能替代官方成分核验。
- 查询不授权下单、支付、扣积分或领券。只有用户明确要求领券时才考虑对应工具。
- 天气需用户提供或由可用天气来源读取；缺失时不编造。星座和老黄历仅用于趣味文案与软偏好，不预测吉凶，也不突破预算。
- 选择不等于吃过；数据不足不编造趋势。CLI 本地记忆与网页账户存档独立，尚未自动同步。

## 运行入口

Token 从环境变量 MCD_MCP_TOKEN 读取，不写入源码、示例或日志。Node.js 22+，从本 Skill 目录执行：

```sh
node scripts/run.mjs --city 上海 --slot dinner --budget 35 --json
node scripts/run.mjs --slot snack --purpose drink-only --drink hot --budget 20
node scripts/run.mjs --record selected --record-id <推荐返回的id> --slot dinner
node scripts/run.mjs --record consumed --record-id <推荐返回的id> --slot dinner
node scripts/run.mjs --feedback like --feedback-id <推荐返回的id>
node scripts/run.mjs --view
node scripts/run.mjs --help
```

展示推荐不意味着已下单。提醒需求转交 maimen-calendar；不要仅用一句“到时提醒你”替代真实日历或调度工具。

## 按需阅读

- [推荐规则](references/recommendation-rules.md)：筛选、排序、无解。
- [MCP 字段](references/mcd-tools.md)：门店、商品编码、报价单位。
- [记忆结构](references/memory-schema.md)：查看、撤销、导出、清空；--clear 全清，--clear-keep-confirmed 保留明确偏好。
- [输出合同](references/output-contract.md)：来源、比较范围、错误状态。
- [验收](references/acceptance.md)：能力与待完成项。

## 验证

```sh
node scripts/test.mjs
node scripts/integration.test.mjs
```

以上为离线与模拟传输回归。真实账号联调另用 scripts/verify-mcp.mjs，不能把离线通过写成真实接口验证通过。
