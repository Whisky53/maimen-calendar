---
name: maimen-calendar
description: 查询麦当劳活动日历，结合天气安排早餐、午餐、晚餐、夜宵和加餐提醒，导出 ICS 或本地订阅。用于“这周有什么活动”“哪天值得去”“安排吃饭提醒”“把活动放进日历”；单餐核价与口味记忆交给 maimen-meal。
---

# 麦门日历

核心是日历：把活动、各餐次提醒与用餐安排放在同一条时间线上。打工人可以有预算结界，也该有按时吃饭的空档。

## 工作流程

1. 读取城市、时间范围、餐次及预算。脚本默认上海、7 天、午餐、35 元；支持 breakfast / lunch / dinner / late-night / snack，不把默认值描述成用户已确认。
2. 调用 campaign-calendar 读取实际返回的日期与活动。返回范围之外标记未取得数据，不编造整月活动；往期内容只作回顾，不推荐成未来机会。
3. 活动力度是本地启发式评分，不是官方省钱金额。低分可能仍有内容活动；当前门店券不证明未来日期可用。
4. 有天气来源才加入天气信息，缺失保持未知。中国天气网是独立来源，不属于麦当劳 MCP。
5. 用户要具体吃什么、核价或记录偏好时，调用配套 maimen-meal。calendar 的 cli.mjs 当前候选按菜单标价筛选，未走逐套服务端核价、未写入 meal 的历史；不要把这条路径称为实付最优推荐。
6. 按餐次与已保存的提醒设置生成日程。未来提醒不意味着未来餐品、供应、价格已确认；先安排时间，到时重新查询。
7. 用户需要时导出 ICS 或启动本地订阅，并说明交付状态。

## 提醒交付

- ICS：只能确认文件已生成。用户需导入并允许日历通知；不能承诺已添加或一定弹窗。
- 本地订阅：服务进程和地址须持续可达；127.0.0.1 地址不能直接给手机或云日历使用。客户端刷新时间由客户端决定。
- 宿主调度：只有实际调用成功后才说已创建；网页关闭后运行必须依赖真实后台能力。
- 星期一至五不是法定工作日，不自动推断节假日调休。
- 稳定 UID 避免重复事件；更新是否覆盖取决于客户端的导入/订阅行为。不能保证反复手动导入一定去重。

## 可选内容

只有用户询问热量或训练时才读取营养与训练模块。缺失热量保持 unknown，模糊匹配需说明；单餐数据不足以推断全天收支，不作医疗或过敏安全结论。星座与老黄历作为趣味文案，不替代事实来源。

不自动下单、付款、扣积分、领券。Token 通过 MCD_MCP_TOKEN 注入，不能写入源码或日志。

## 运行入口

Node.js 22+，从本 Skill 目录执行：

```sh
node scripts/cli.mjs --city 上海 --days 7 --budget 35 --slots breakfast,lunch,dinner --ics ./maimen.ics
node scripts/cli.mjs --setup-reminders --slots breakfast,lunch --remind-lunch 11:45
node scripts/cli.mjs --slot-config dinner --disable
node scripts/cli.mjs --view-reminders
node scripts/serve.mjs --port 8899 --city 上海
node scripts/cli.mjs --help
```

无 Token 时说明活动/菜单等不可用。明确要求演示时可使用 --demo；示例与实时数据分开标注。网页原型、CLI 提醒文件和宿主调度是独立状态，不宣称自动同步。

## 按需阅读与验证

- [日历规则](references/calendar-rules.md)：评分、UID、热量与训练细节。
- [数据源](references/data-sources.md)：接口字段与来源。
- ../maimen-meal/SKILL.md：单餐实时核价、选择和吃过记录。

运行 node scripts/test.mjs 验证离线规则；涉及真实接口时另做只读联调，报告实际成功的接口，不把计划当作已完成。
