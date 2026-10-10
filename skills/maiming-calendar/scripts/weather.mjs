/**
 * 中国天气网数据适配层。
 *
 * 数据源：www.weather.com.cn（官方）
 * 关键：d1.weather.com.cn 反爬严格，必须同时带对 Referer + 浏览器 UA，
 *       否则返回 403（openresty）。Referer 必须是「城市页」而非首页。
 *
 * 三个可用接口（均已实测）：
 *   /sk_2d/{cityCode}.html          → 实时天气（dataSK）
 *   /weather_index/{cityCode}.html  → 实时+今日+未来预报+生活指数（cityDZ/dataSK/dataZS…）
 *   /weather1d/{cityCode}.shtml     → 当日详情（HTML，备用）
 *
 * 无网络时全部降级为 null，由上层回退到本地推断。
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 常用城市 → 中国天气网城市码。可按需扩充。 */
export const CITY_CODES = {
  北京: "101010100",
  上海: "101020100",
  广州: "101280101",
  深圳: "101280601",
  杭州: "101210101",
  成都: "101270101",
  武汉: "101200101",
  南京: "101190101",
  西安: "101110101",
  重庆: "101040100",
  天津: "101030100",
  苏州: "101190401",
  长沙: "101250101",
  郑州: "101180101",
  青岛: "101120201",
};

/** 城市名 → 城市码；已是数字码则原样返回。 */
export function cityCodeOf(city) {
  if (!city) return null;
  const s = String(city).trim();
  if (/^\d{9}$/.test(s)) return s;
  const key = s.replace(/市$/, "");
  return CITY_CODES[key] || null;
}

function headers(cityCode) {
  return {
    // ⚠️ Referer 必须指向该城市页，否则 403
    Referer: `http://www.weather.com.cn/weather/${cityCode}.shtml`,
    "User-Agent": UA,
    Accept: "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };
}

/** 解析 "var name ={...};" 形式的返回体。 */
function parseVarBody(text, varName) {
  const re = new RegExp(`var\\s+${varName}\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;`);
  const m = text.match(re);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** 抓取并解析一个返回体里所有的 var 声明。 */
async function fetchVars(cityCode, path, varNames) {
  const url = `http://d1.weather.com.cn/${path}/${cityCode}.html`;
  const res = await fetch(url, { headers: headers(cityCode) });
  if (!res.ok) throw new Error(`天气接口 HTTP ${res.status}`);
  const text = await res.text();
  if (/Forbidden/i.test(text)) throw new Error("天气接口被拒绝（403）");
  const out = {};
  for (const v of varNames) out[v] = parseVarBody(text, v);
  return out;
}

/** 实时天气（含温度、天气现象、风力、湿度、AQI）。 */
export async function realtime(city) {
  const code = cityCodeOf(city);
  if (!code) throw new Error(`未收录的城市：${city}`);
  // 注：sk_2d 单独请求偶发被拒；weather_index 一次就能拿到 dataSK，更稳。
  let d = null;
  try {
    const vars = await fetchVars(code, "sk_2d", ["dataSK"]);
    d = vars.dataSK;
  } catch {
    /* 回退到 weather_index */
  }
  if (!d) {
    const vars = await fetchVars(code, "weather_index", ["dataSK"]);
    d = vars.dataSK;
  }
  if (!d) return null;
  return {
    city: d.cityname,
    cityCode: code,
    tempC: Number(d.temp),
    weather: d.weather,
    weatherCode: d.weathercode,
    windDir: d.WD,
    windLevel: d.WS,
    humidity: d.SD,
    aqi: Number(d.aqi),
    rain24h: d.rain24h,
    observedAt: `${d.date} ${d.time}`,
    source: "中国天气网",
  };
}

/** 7 天预报 + 生活指数（一次请求拿全）。 */
export async function forecast(city) {
  const code = cityCodeOf(city);
  if (!code) throw new Error(`未收录的城市：${city}`);
  const vars = await fetchVars(code, "weather_index", [
    "cityDZ",
    "dataSK",
    "dataZS",
    "fc",
  ]);
  const today = vars.cityDZ && vars.cityDZ.weatherinfo ? vars.cityDZ.weatherinfo : null;
  const life = vars.dataZS && vars.dataZS.zs ? vars.dataZS.zs : null;
  const days = vars.fc && vars.fc.f ? vars.fc.f : null;

  return {
    cityCode: code,
    today: today
      ? {
          tempHigh: Number(today.temp),
          tempLow: Number(today.tempn),
          weather: today.weather,
          wind: `${today.wd} ${today.ws}`,
          forecastTime: today.fctime,
        }
      : null,
    // 未来逐日（结构随站点版本变化，做宽松解析）
    days: Array.isArray(days)
      ? days.map((d) => ({
          date: d.fa ? `${d.fa.slice(0, 4)}-${d.fa.slice(4, 6)}-${d.fa.slice(6, 8)}` : null,
          weather: d.fb || d.weather || null,
          tempHigh: d.fc ? Number(d.fc) : null,
          tempLow: d.fd ? Number(d.fd) : null,
          wind: d.fe || null,
        }))
      : [],
    life: life
      ? {
          comfort: { hint: life.co_hint, desc: life.co_des_s },
          dressing: { hint: life.ct_hint, desc: life.ct_des_s },
          cold: { hint: life.gm_hint, desc: life.gm_des_s },
          sport: { hint: life.yd_hint, desc: life.yd_des_s },
          uv: { hint: life.uv_hint, desc: life.uv_des_s },
          umbrella: { hint: life.ys_hint, desc: life.ys_des_s },
        }
      : null,
    source: "中国天气网",
  };
}

/** 一次性拿到「推荐所需的天气输入」（实时 + 今日预报）。 */
export async function weatherInput(city) {
  const [rt, fc] = await Promise.allSettled([realtime(city), forecast(city)]);
  const r = rt.status === "fulfilled" ? rt.value : null;
  const f = fc.status === "fulfilled" ? fc.value : null;
  if (!r && !f) return null;
  const precip = detectPrecipitation(r, f);
  const wind = (f && f.today && f.today.wind) || (r && r.wind) || "";
  const todayText = (f && f.today && f.today.weather) || (r && r.weather) || "";
  return {
    city: (r && r.city) || city,
    tempC: r ? r.tempC : f && f.today ? f.today.tempHigh : null,
    tempLow: f && f.today ? f.today.tempLow : null,
    tempHigh: f && f.today ? f.today.tempHigh : null,
    precipitation: precip,
    precipLevel: precipLevelOf(precip, todayText, f),
    condition: (r && r.weather) || (f && f.today && f.today.weather) || null,
    aqi: r ? r.aqi : null,
    wind,
    windLevel: windLevelOf(wind),
    uv: uvLevelOf(f, todayText),
    weather: todayText,
    source: "中国天气网",
    raw: { realtime: r, forecast: f },
  };
}

/**
 * 降水强度分级。「小雨」与「暴雨/雷阵雨」对推荐的影响不同。
 * @returns {"none"|"light"|"heavy"}
 */
export function precipLevelOf(precip, text = "", f = null) {
  if (precip === "none") return "none";
  const all = [
    text,
    ...((f && f.days) || []).map((d) => d.weather),
  ]
    .filter(Boolean)
    .join(" ");
  if (/暴雨|大暴雨|雷阵雨|雷暴|大雨|强降水|暴雪|大雪/.test(all)) return "heavy";
  return "light";
}

/**
 * 风力等级 → 数字（级）。
 * 中国天气网文本形如「东北风 3级」「无持续风向 微风」「4-5级」「东风转北风 <3级」。
 * 注意「<3级」应取 2（不足 3 级），不能读成 3。
 * @returns {number|null}
 */
export function windLevelOf(text = "") {
  const s = String(text || "");
  const lt = s.match(/<\s*(\d+)\s*级/);
  if (lt) return Math.max(0, Number(lt[1]) - 1);
  const m = s.match(/(\d+)\s*[-~到]?\s*(\d+)?\s*级/);
  if (m) return Number(m[2] || m[1]);
  if (/微风/.test(s)) return 2;
  return null;
}

/**
 * 紫外线强度 → "weak" | "normal" | "strong"。
 * 中国天气网生活指数里 uv_hint 形如「很强」「弱」「中等」。
 */
export function uvLevelOf(f = null, text = "") {
  const hint = String(
    (f && f.life && f.life.uv && f.life.uv.hint) || (f && f.life && f.life.uv_hint) || ""
  );
  const src = `${hint} ${text}`;
  if (/很强|极强|强/.test(src)) return "strong";
  if (/最弱|弱/.test(src)) return "weak";
  return "normal";
}

/** 从实况与预报文本里判断降水类型。 */
function detectPrecipitation(r, f) {
  const text = [
    r && r.weather,
    f && f.today && f.today.weather,
    ...((f && f.days) || []).map((d) => d.weather),
  ]
    .filter(Boolean)
    .join(" ");
  if (/雪/.test(text)) return "snow";
  if (/雨|雷|阵雨/.test(text)) return "rain";
  return "none";
}

/**
 * 温度分层规则（2026-10-10 优化为四层；使用者选定的「标准」）。
 * 返回带可解释 reason 的偏好信号，与 maiming-lunch 的 preference 结构一致。
 *
 * 设计要点：
 *  1) 温度四分层（原为 ≤10 / ≥30 二分，中间一大段"不限"浪费了）
 *  2) 降水分强弱，且与温度叠加后做「冲突消解」
 *  3) AQI 三档（原只有 >150 一档）
 *  4) 新增风力、紫外线两个信号
 *  5) **冲突消解**：多个温度倾向信号（hot/cold）矛盾时，取 weight 高者主导，
 *     其余降级为 note，避免上层推荐拿到互相打架的信号。
 *
 * @param {object} w weatherInput 的产物
 * @param {object} [thresholds] 自定义阈值 { severeCold, coldMax, hotMin, severeHot, aqiPoor, aqiBad, windStrong }
 */
export function weatherPolicy(w, thresholds = {}) {
  const t = {
    severeCold: 5,
    coldMax: 15,
    hotMin: 28,
    severeHot: 35,
    aqiPoor: 100,
    aqiBad: 150,
    windStrong: 6,
    ...thresholds,
  };
  const signals = [];
  const notes = [];
  if (!w) return signals;

  const temp = typeof w.tempC === "number" ? w.tempC : null;
  const precip = w.precipitation || "none";
  const precipLv = w.precipLevel || (precip === "none" ? "none" : "light");
  const aqi = typeof w.aqi === "number" ? w.aqi : null;
  const windLv = typeof w.windLevel === "number" ? w.windLevel : null;
  const uv = w.uv || "normal";

  // ── ① 温度四分层 ──
  if (temp !== null) {
    if (temp <= t.severeCold) {
      signals.push({ kind: "temp", value: "hot", weight: 3, reason: `${temp}°C 严寒（≤${t.severeCold}°C），强烈建议热食热饮` });
    } else if (temp <= t.coldMax) {
      signals.push({ kind: "temp", value: "hot", weight: 2, reason: `${temp}°C 偏凉（≤${t.coldMax}°C），优先热食热饮` });
    } else if (temp >= t.severeHot) {
      signals.push({ kind: "temp", value: "cold", weight: 3, reason: `${temp}°C 酷热（≥${t.severeHot}°C），强烈建议冰饮清爽` });
    } else if (temp >= t.hotMin) {
      signals.push({ kind: "temp", value: "cold", weight: 2, reason: `${temp}°C 偏热（≥${t.hotMin}°C），优先冰饮清爽` });
    } else {
      signals.push({ kind: "temp", value: "any", weight: 1, reason: `${temp}°C 气温舒适，温度不限` });
    }
  }

  // ── ② 降水分强弱 + 与温度叠加（冲突消解）──
  if (precip === "rain" || precip === "snow") {
    const isSnow = precip === "snow";
    const cn = isSnow ? "降雪" : "降水";
    const strong = precipLv === "heavy";
    // 极端高温 + 降水：温度诉求更强，降水降级为备注
    const tempSignal = signals.find((s) => s.kind === "temp");
    const tempHot = tempSignal && tempSignal.value === "cold" && tempSignal.weight >= 3;
    if (tempHot) {
      notes.push(`今日有${cn}，但气温很高；若不想喝冰的，可选常温或热汤类`);
    } else {
      signals.push({
        kind: "occasion",
        value: "warm",
        weight: strong ? 2 : 1,
        reason: `今日有${strong ? "较强" : ""}${cn}，偏向暖胃、汤食类`,
      });
    }
  }

  // ── ③ AQI 三档 ──
  if (aqi !== null) {
    if (aqi >= t.aqiBad) {
      signals.push({ kind: "air", value: "indoor", weight: 2, reason: `AQI ${aqi} 较差，建议减少外出、优先堂食或外送` });
    } else if (aqi >= t.aqiPoor) {
      notes.push(`AQI ${aqi} 轻度污染，敏感人群可考虑外送`);
    }
  }

  // ── ④ 风力 ──
  if (windLv !== null && windLv >= t.windStrong) {
    notes.push(`${windLv} 级大风，外带/户外用餐体验会打折，建议堂食`);
  }

  // ── ⑤ 紫外线 ──
  if (uv === "strong") {
    const tempSignal = signals.find((s) => s.kind === "temp");
    if (tempSignal && tempSignal.value === "cold") {
      // 本来就该冰饮，紫外线只是强化
      tempSignal.weight = Math.min(3, tempSignal.weight + 1);
      tempSignal.reason += "，紫外线强，冰饮更解暑";
    } else {
      notes.push("紫外线较强，搭配冰饮更舒服，也记得防晒");
    }
  }

  // 附加备注（不改变主导倾向，仅作提示）
  if (notes.length) {
    signals.push({ kind: "note", value: "info", weight: 0, reason: notes.join("；") });
  }
  return signals;
}
