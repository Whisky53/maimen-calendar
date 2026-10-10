# 数据源与接口实测记录

本文件记录 maiming-calendar 用到的所有外部数据源的**实测结果**，供后续维护参考。
所有"实测"均指本机真实调用成功并核对过字段，不是文档推断。

---

## 一、中国天气网（www.weather.com.cn）

### 反爬要点（最容易踩的坑）

`d1.weather.com.cn` 有严格反爬，**三个条件缺一不可**，否则返回 `403 Forbidden`（openresty）：

| 条件 | 值 |
| --- | --- |
| **Referer** | `http://www.weather.com.cn/weather/{cityCode}.shtml`（**必须是城市页，不能是首页**） |
| **User-Agent** | 普通浏览器 UA（如 Chrome） |
| 协议 | http / https 均可 |

### 可用接口

| 接口 | 返回 | 说明 |
| --- | --- | --- |
| `http://d1.weather.com.cn/sk_2d/{cityCode}.html` | `var dataSK={...}` | 实时天气 |
| `http://d1.weather.com.cn/weather_index/{cityCode}.html` | `cityDZ` + `dataSK` + `dataZS` + `fc` | 一次拿全：今日预报 + 实时 + 生活指数 + 未来 |

> ⚠️ 实测 `sk_2d` 单独请求**偶发被拒**，`weather_index` 更稳定。
> 因此 `weather.mjs` 的 `realtime()` 先试 `sk_2d`，失败自动回退 `weather_index`。

### 字段说明（实测）

`dataSK`（实时）：
```
cityname 城市名 / temp 温度 / weather 天气现象 / weathercode 天气码
WD 风向 / WS 风力 / SD 湿度 / aqi 空气质量 / rain24h 24h降水 / date+time 观测时间
```

`cityDZ.weatherinfo`（今日预报）：
```
temp 最高温 / tempn 最低温 / weather 天气 / wd 风向 / ws 风力 / fctime 预报时间
```

`dataZS.zs`（生活指数）：
```
co_ 舒适度 / ct_ 穿衣 / gm_ 感冒 / yd_ 运动 / lk_ 路况 / nl_ 夜生活 / gj_ 逛街 / tr_ 旅游
uv_ 紫外线 / ys_ 雨伞 / pl_ 空气污染扩散 / …
字段格式：xx_name 名称 / xx_hint 简要 / xx_des_s 详细描述
```
> ⚠️ 紫外线指数实测字段为 `uv_hint`（如「强」），雨伞为 `ys_hint`（如「不带伞」）。
> `weather.mjs` 的 `uvLevelOf()` 只读 `uv_hint`，不再猜其他字段名。

### 派生字段（weatherInput 产出，供 weatherPolicy 用）

在原始字段之上，`weatherInput()` 额外派生：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `precipLevel` | `detectPrecipitation` + 文本 | `none` / `light` / `heavy`（暴雨/雷阵雨/大雨=heavy） |
| `windLevel` | 风力文本解析 | 数字级数。⚠️ `<3级` 应解析为 **2**，不能读成 3 |
| `uv` | `life.uv.hint` | `weak` / `normal` / `strong` |
| `tempLow` / `tempHigh` | `cityDZ.weatherinfo` | 与实时 `tempC` 口径不同，仅作参考展示，温度分层以 `tempC` 为准 |

### 实测样例（2026-10-10 上海）

```json
{"cityname":"上海","temp":"25.1","weather":"阴","WD":"北风","WS":"0级","SD":"68%","aqi":"27","date":"10月10日(星期六)","time":"11:00"}
```
> 注：实况气温（25.1°C）常高于当日预报最高温（22°C），属正常——
> 实况是此刻观测值，预报是全天区间。温度分层**以实况为准**。

### 已收录城市码

北京 101010100 / 上海 101020100 / 广州 101280101 / 深圳 101280601 / 杭州 101210101
成都 101270101 / 武汉 101200101 / 南京 101190101 / 西安 101110101 / 重庆 101040100
天津 101030100 / 苏州 101190401 / 长沙 101250101 / 郑州 101180101 / 青岛 101120201

---

## 二、麦当劳 MCP（mcp.mcd.cn）

复用 `maiming-lunch` 已实测的接口事实，本 Skill 额外接入三个工具。

### 通用要点（已实测确认）

- 协议：Streamable HTTP（JSON-RPC 2.0），`Authorization: Bearer <TOKEN>`
- 服务端标识：`mcd-mcp v1.0.0`，共 **35 个** Tool
- 响应优先取 `result.structuredContent`（同时存在 `content[0].text`）
- `structuredContent.success === false` 时带 `code` / `message`
- 限流 600 次/分钟

### 本 Skill 使用的工具

| Tool | 用途 | 实测结果 |
| --- | --- | --- |
| `campaign-calendar` | 当月活动日历 | ✅ 12 天，含今天 15 个事件 |
| `query-store-coupons` | 门店可用券 | ✅ 接口正常（该账号券包为空，返回 `data:null`） |
| `list-nutrition-foods` | 营养热量表 | ✅ **160 条** |
| `query-nearby-stores` | 查门店拿 storeCode | ✅ |
| `query-meals` | 真实菜单 | ✅ 13 分类 / 97 餐品 |

### `campaign-calendar` 结构（实测）

```json
{
  "currentTime": "2026-10-10 11:21:20",
  "dailyList": [
    {
      "date": "2026-10-10",
      "dateText": "2026年10月10日 往期回顾",
      "today": true,
      "events": [
        {
          "activityCode": "45f3",
          "eventType": 4,
          "activityStage": 3,
          "articleDto": {
            "title": "超值𝟗.𝟗元早餐两件套陪你开工啦😋",
            "content": "早八的快乐…",
            "highlights": "9.9元超值早餐正式上新!",
            "buttonText": "立即领券",
            "appJumpUrl": "mcdapp://…"
          }
        }
      ]
    }
  ],
  "subscribedEvents": []
}
```

> 事件文案在 `articleDto.title` / `articleDto.content`；`activityTitle` 常为空。

**⚠️ 三个实测大坑（评分引擎必须处理，否则误判）：**

1. **往期活动混在 dailyList 里**：`dateText` 形如「2026年10月10日 往期回顾」的日期，
   活动其实已经结束，但结构上和未来活动完全一样。必须靠 `dateText` 含「往期/回顾/已结束」
   或日期早于今天来剔除，否则会把过期活动推荐成"接下来最值得吃的一天"。

2. **营销文案使用数学粗体数字**：`超值𝟗.𝟗元` 里的 `𝟗` 是 **U+1D7D7**（MATHEMATICAL BOLD DIGIT NINE），
   既非半角 `9` 也非全角 `９`，普通 `/[0-9]/` 完全匹配不到。
   同类还有数学粗斜体（U+1D7D8–1D7E1）、等宽（U+1D7F6–1D7FF）。
   另有网络写法 `13.9r`（r = 元）。**必须先归一化再匹配关键词**。

3. **同一长期活动跨天重复推送**：`campaign-calendar` 会把"9.9元早餐"这类长期活动，
   在其覆盖的每一天都推一遍。若每天按"新优惠"计分，长期活动会把整月分数拉平。
   实测 10-10 有 15 个不同活动（activityCode 全不同，**不是重复**），但同一条活动在
   10-07/10-10/10-13 反复出现，必须做跨天去重降权。

**另一个反直觉点**：`加 39.9 元即可得周边` 这类**加价换购**，本质是多花钱买周边，
不是省钱。若同时命中「明确标价(+22)」和「买赠(+26)」会双重计分虚高，需用 `skipIf` 让位。

### `list-nutrition-foods` ⚠️ 特殊格式

**返回值不是标准 JSON**，而是一段紧凑文本表格，形如：

```
"[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
  猪柳麦满分,null,1288,308,16,16,24,781,213
  中薯条,null,1210,289,4,12,38,165,18
  …"
```

字段顺序（**固定**）：
`productName, nutritionDescription, energyKj, energyKcal, protein, fat, carbohydrate, sodium, calcium`

因此 `mcd.mjs` 的 `parseNutrition()` 专门做了逐行 CSV 解析，同时兼容标准 JSON 数组形态。

实测样例：
```
巨无霸      2146 kJ / 513 kcal / 蛋白27g / 脂肪26g / 碳水42g / 钠961mg / 钙171mg
麦乐鸡5块    890 kJ / 213 kcal / 蛋白12g / 脂肪12g / 碳水13g / 钠422mg / 钙9mg
中薯条      1210 kJ / 289 kcal / 蛋白 4g / 脂肪12g / 碳水38g / 钠165mg / 钙18mg
```

> 餐品名与营养表名不完全一致，`lookupKcal()` 做了三级容错匹配
> （精确 → 去括号空格 → 双向包含取最长）。

---

## 三、已知限制

| 项 | 说明 |
| --- | --- |
| 天气城市覆盖 | 仅内置 15 个主要城市，其他需传 9 位城市码 |
| 活动力度评分 | 启发式规则，非官方优惠金额 |
| 门店券 | 取决于账号券包，空券包时该维度不计分 |
| 谷歌日历订阅 | 需公网地址，本机 127.0.0.1 谷歌拉取不到 |
| 营养匹配 | 菜单名与营养表名不一致时靠模糊匹配，可能漏配（漏配则该餐品不计热量分） |
| 训练消耗 | MET 估算，个体差异可达 ±20% |
