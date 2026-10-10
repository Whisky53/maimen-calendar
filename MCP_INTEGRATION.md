# MCP 集成说明

本文说明「麦门日历」如何接入**麦当劳 MCP Server**，用了哪些 Tool、调用流程如何、
以及每个 Tool 在业务里创造了什么价值。所有内容均基于**真实联调实测**。

---

## 一、接入方式

| 项 | 值 |
| --- | --- |
| 协议 | Streamable HTTP（JSON-RPC 2.0） |
| 接入地址 | `https://mcp.mcd.cn` |
| 鉴权 | `Authorization: Bearer <MCD_MCP_TOKEN>` |
| 请求方式 | `POST`，`Content-Type: application/json` |
| 服务端 | `mcd-mcp v1.0.0` |
| 限流 | 600 次/分钟 |

调用统一封装在 `skills/*/scripts/mcp.mjs`（lunch）与 `skills/maiming-calendar/scripts/mcd.mjs`（calendar），
对外暴露语义化方法：

```js
export const mcd = {
  nearbyStores: (p) => callTool("query-nearby-stores", { beType: 1, searchType: 1, ...p }),
  meals:         (p) => callTool("query-meals",         { ...STORE_CONTEXT, ...p }),
  mealDetail:    (p) => callTool("query-meal-detail",   { ...STORE_CONTEXT, ...p }),
  calculatePrice:(p) => callTool("calculate-price",     { ...STORE_CONTEXT, ...p }),
  storeCoupons:  (p) => callTool("query-store-coupons", { ...STORE_CONTEXT, ...p }),
  myCoupons:     (p) => callTool("query-my-coupons",    { ...p }),
  availableCoupons: (p) => callTool("available-coupons",{ ...p }),
  autoBindCoupons: () => callTool("auto-bind-coupons",  {}),
  campaignCalendar: (p) => callTool("campaign-calendar",{ ...p }),
  nutrition:     (p) => callTool("list-nutrition-foods",{ ...p }),
  now:           () => callTool("now-time-info",        {}),
};
```

> `STORE_CONTEXT = { beType: 1, orderType: 1 }`，是多数门店级接口的必填上下文。

---

## 二、使用的 Tool 与业务价值

| # | Tool | 用在哪 | 业务价值 |
| --- | --- | --- | --- |
| 1 | `query-nearby-stores` | 定位门店拿 `storeCode` | 后续所有菜单/价格/券查询的入口 |
| 2 | `query-meals` | 拉当前门店可售餐品 | 构建候选套餐池（实测 97 餐品 / 13 分类） |
| 3 | `query-meal-detail` | 查套餐组成与可替换项 | 组装/拆解套餐 |
| 4 | `calculate-price` | **服务端精算应付价** | ⭐ 核心：同价位候选逐个询价，找出最省 |
| 5 | `query-store-coupons` | 查当前门店可用券 | 把券叠进力度评分与比价 |
| 6 | `query-my-coupons` | 查"我"的券 | 叠加个人券算最优 |
| 7 | `available-coupons` | 麦麦省券列表 | 发现可领券 |
| 8 | `auto-bind-coupons` | 一键领券 | 先领券再比价 |
| 9 | `campaign-calendar` | 当月活动日历 | ⭐ 核心：活动力度评分的唯一数据源 |
| 10 | `list-nutrition-foods` | 官方营养表（160 条） | 热量摄入计算 |

---

## 三、核心调用流程

### 流程 A：午饭推荐 + 真实比价（maiming-lunch）

```
① query-nearby-stores          → storeCode
        ↓
② query-meals                  → 97 个真实餐品
        ↓
③ 本地组装 N 套候选套餐（官方套餐优先）
        ↓
④ calculate-price × N          → 每套的应付价（服务端精算，单位：分）
        ↓
⑤ 取最省方案 → 输出推荐
```

**关键实测事实**（都是踩坑换来的，勿凭猜测改动）：

```js
// items 的商品字段名是 productCode（不是 code），写错会静默返回 price=0
await calculatePrice({
  storeCode: "1400685",
  items: [{ productCode: "xxx", quantity: 1 }],
});
// 返回 price / originalPrice / discount 单位是「分」
```

### 流程 B：活动力度 + 日历规划（maiming-calendar）

```
① campaign-calendar            → dailyList[]（当月活动日历）
        ↓
② 归一化花式数字 + 同日去重 + 跨日降权 + 剔除往期
        ↓
③ 关键词评分（优惠型高权重 / 内容型低权重封顶）
        ↓
④ query-store-coupons          → 门店券加成
        ↓
⑤ 天气（中国天气网） → 温度分层 → 饮食倾向
        ↓
⑥ list-nutrition-foods         → 热量核对
        ↓
⑦ 训练计划（MET） → 热量收支平衡
        ↓
⑧ 生成日程 → 导出 .ics
```

---

## 四、实测踩坑记录（重要）

这几个坑都是**真实联调**中发现的，写在这里供评审与其他开发者参考：

| # | 坑 | 现象 | 解法 |
| --- | --- | --- | --- |
| 1 | `calculate-price` 字段名 | `items` 里写 `code` 而非 `productCode`，**不报错但 price=0** | 用 `productCode` |
| 2 | `query-meals` 城市必填 | `searchType=2` 需经纬度，否则 `code=600058` | 用 `searchType=1` |
| 3 | 单位不一致 | `calculate-price` 是**分**，`query-meals` 是**元** | 各自换算，勿混用 |
| 4 | 花式数字 | 文案用数学粗体 `𝟗.𝟗元`（U+1D7D7），`/[0-9]/` 匹配不到 | 归一化全角/粗体/粗斜体/等宽四类数字 |
| 5 | 往期活动混入 | `dailyList` 含"往期回顾"日期，结构上与未来活动无异 | 按 `dateText` + 日期双重判定剔除 |
| 6 | 长期活动跨天重复 | 同一活动在其覆盖的每一天都被推一遍 | 跨天去重 + 降权 |
| 7 | 营养表非标准 JSON | `list-nutrition-foods` 返回紧凑文本表格 | 逐行 CSV 解析（字段顺序固定） |
| 8 | 响应双重承载 | 结果同时在 `result.content[0].text` 与 `result.structuredContent` | 两处都解析，取可用者 |

---

## 五、业务价值总结

1. **"最优惠价格"是真的**：不靠规则猜，而是调 `calculate-price` 由**麦当劳服务端精算**。
2. **"活动力度"是可解释的**：不是黑盒打分，每条分数都能说出命中了哪些关键词、扣了什么。
3. **"该不该去"有据可依**：天气 + 力度 + 热量 + 预算四个维度联合决策。
4. **零资金风险**：只查询、只提醒，**不创建订单、不支付**。

---

## 六、安全与合规

- Token 只从环境变量 `MCD_MCP_TOKEN` 读取，**不写入任何源码/配置/日志**。
- 仓库内 `.gitignore` 已排除 `.env*`，`mcp-config.example.json` 只含占位符。
- 所有 MCP 调用为**只读询价**，无下单/支付接口调用。
- 本工具为非官方应用，与麦当劳官方无隶属关系。
