# 麦当劳 MCP 工具清单与用法对照

来源：官方接入指南 <https://github.com/M-China/mcd-mcp-server> + **2026-10-10 实测**。
接入地址：`https://mcp.mcd.cn`，协议 Streamable HTTP（JSON-RPC 2.0），鉴权 `Authorization: Bearer <TOKEN>`。
服务端标识：`mcd-mcp v1.0.0`，共 **35 个** Tool。限流：600 次/分钟，超出返回 429。

## 本 Skill 实际使用的工具

| Tool | 用途 | 本 Skill 调用位置 |
| --- | --- | --- |
| `query-nearby-stores` | 查可点餐门店，拿 `storeCode` | `mcp.mjs` → `mcd.nearbyStores()` |
| `query-meals` | 读门店真实菜单与价格 | `mcp.mjs` → `mcd.meals()` |
| `calculate-price` | 精算应付金额（单位：分） | `mcp.mjs` → `comparePrices()` |
| `query-meal-detail` | 套餐组成与可替换项 | 组装候选组合（扩展点） |
| `query-store-coupons` | 指定门店+订单类型可用券 | 比价前收集可用券（扩展点） |
| `query-my-coupons` | 我的券包 | 叠加个人券算最优（扩展点） |
| `available-coupons` | 麦麦省可领券 | 领券前列表（扩展点） |
| `auto-bind-coupons` | 一键领券 | 先领券再比价（扩展点） |
| `campaign-calendar` | 当月活动 | 结合活动日推荐（扩展点） |
| `now-time-info` | 当前时间 | 早/午/晚餐时段判断 |

## 实测确认的字段事实（重要，勿凭猜测改动）

### 1) `query-nearby-stores`
- 必填：`beType`（1=到店自提 / 5=得来速）、`searchType`（1=收藏 / 2=按位置）
- `searchType=2` 需 `city` 或 `keyword`，否则返回 `code=600058 城市名或者关键词不能为空`
- 返回 `data[]`：`storeCode`、`storeName`、`address`、`beCode`、`reservation`、`reservationTimeOptions`

### 2) `query-meals`
- 必填：`storeCode`（**纯数字**，如 `1400685`）、`beType`、`orderType`（到店自取：`beType=1, orderType=1`）
- 返回结构：
  ```
  data.categories[] : [{ name, meals:[{ code, tags:[] }] }]
  data.meals{}      : { "<code>": { name, image, currentPrice, originalPrice, discountType, canWithOrder } }
  ```
- **`currentPrice` / `originalPrice` 单位是「元」字符串**，如 `"29"`、`"29.5"`
- 实测门店 `1400685`：13 个分类、97 个餐品

### 3) `calculate-price`
- 必填：`storeCode`、`beType`、`orderType`、`items`
- **`items` 商品字段名是 `productCode`（不是 `code`）**：
  ```json
  { "items": [{ "productCode": "1100", "quantity": 1 }] }
  ```
- 返回（**单位：分**）：
  ```
  price / originalPrice / discount / productPrice / deliveryPrice / packingPrice / tablewarePrice
  productList[] : [{ productCode, productName, quantity, originalSubtotal, subtotal }]
  takeWayList[] : [{ code, title, subtitle }]   // 到店下单需携带 takeWayCode
  enjoyed / enjoyable : { amountType, realDiscount, balance }
  ```
- 实测：巨无霸(1100)¥29 + 麦乐鸡5块(1401)¥15.5 + 雪碧中杯(3060)¥11.5 → `price=5600`（分）= ¥56.00 ✅

### 4) 响应封装
- 同时存在 `result.content[0].text`（人类可读说明+原始 JSON）与 **`result.structuredContent`**（结构化对象）
- **优先取 `structuredContent`**；`structuredContent.success === false` 时带 `code` / `message`
- 兼容 `application/json` 与 `text/event-stream`（SSE），`mcp.mjs` 已处理两种

## 尚未使用但可扩展的工具

`delivery-*`（外送地址/门店）、`create-order` / `cancel-order` / `query-order` / `order-list`（订单，本 Skill 明确不做）、`list-nutrition-foods`（营养）、`query-my-account` / `mall-*`（积分商城）、`query-lottery-info` / `draw-lottery` / `query-my-prizes`（抽奖）、`query-party-*` / `party-order-create`（主题活动）。

> 本 Skill 定位为「推荐 + 比价」，**不触碰下单、支付、领券、抽奖等有副作用的工具**。

## 调用方式

```bash
curl -s -X POST "https://mcp.mcd.cn" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $MCD_MCP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query-meals","arguments":{"storeCode":"1400685","beType":1,"orderType":1}}}'
```

## 常见错误码

| code | 含义 | 处理 |
| --- | --- | --- |
| 401 | Token 无效/过期/未提供 | 检查 Authorization 头；**错误信息中不得回显 Token** |
| 429 | 超过 600 次/分钟 | 降低频率、退避重试 |
| 600058 | 门店查询缺城市/关键词 | 补 `city` 或 `keyword` |

## 接入验证清单

- [x] 门店与就餐方式字段名（`storeCode` + `beType` + `orderType`）
- [x] `items` 商品编码字段名（`productCode`）
- [x] `calculate-price` 费用单位与键名（**分**；`price` / `originalPrice` / `discount`）
- [x] 菜单结构与价格字段（`currentPrice` 元字符串）
- [x] Token 有效性（initialize 握手 + tools/list 返回 35 项）
- [ ] 套餐替换规则与加价项（`query-meal-detail`，扩展点）
- [ ] 优惠券适用条件（`query-store-coupons`，扩展点）
- [ ] 不可售错误的表现形式
- [ ] 试算是否存在账户副作用（实测无）
