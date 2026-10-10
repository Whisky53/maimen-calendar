/**
 * 偏好映射：把天气与星座转成可解释的饮食偏好信号。
 *
 * 设计原则：
 * - 只产出「软偏好」（温度倾向、口味倾向），不突破预算/忌口等硬约束。
 * - 每条信号都带 reason，便于在推荐理由里向用户解释。
 * - 不进行运势预测；星座只作为「口味倾向」的趣味因子，等权于一条软偏好。
 */

/** 12 星座 → 元素归属。 */
const ZODIAC = [
  { name: "摩羯座", element: "earth", from: [12, 22], to: [1, 19] },
  { name: "水瓶座", element: "air", from: [1, 20], to: [2, 18] },
  { name: "双鱼座", element: "water", from: [2, 19], to: [3, 20] },
  { name: "白羊座", element: "fire", from: [3, 21], to: [4, 19] },
  { name: "金牛座", element: "earth", from: [4, 20], to: [5, 20] },
  { name: "双子座", element: "air", from: [5, 21], to: [6, 21] },
  { name: "巨蟹座", element: "water", from: [6, 22], to: [7, 22] },
  { name: "狮子座", element: "fire", from: [7, 23], to: [8, 22] },
  { name: "处女座", element: "earth", from: [8, 23], to: [9, 22] },
  { name: "天秤座", element: "air", from: [9, 23], to: [10, 23] },
  { name: "天蝎座", element: "water", from: [10, 24], to: [11, 22] },
  { name: "射手座", element: "fire", from: [11, 23], to: [12, 21] },
];

/** 元素 → 口味倾向（软偏好，仅影响排序）。 */
const ELEMENT_TRAIT = {
  fire: { temp: "cold", note: "行动派偏清爽，冰饮更对味" },
  earth: { temp: "hot", note: "踏实派偏暖食，热饮更安稳" },
  air: { temp: "any", note: "随性派不挑温度，看当天心情" },
  water: { temp: "hot", note: "细腻派偏温润，热食更治愈" },
};

/** 按生日字符串（YYYY-MM-DD 或 MM-DD）取星座。 */
export function zodiacOf(birthday) {
  if (!birthday) return null;
  const m = String(birthday).match(/(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  for (const z of ZODIAC) {
    const [fm, fd] = z.from;
    const [tm, td] = z.to;
    if (fm <= tm) {
      if ((month === fm && day >= fd) || (month === tm && day <= td)) return z;
    } else {
      // 跨年（摩羯）
      if ((month === fm && day >= fd) || (month === tm && day <= td)) return z;
    }
  }
  return null;
}

/**
 * 天气 → 偏好信号。
 * @param {{tempC?:number, precipitation?:string, condition?:string, source?:string}} weather
 */
export function weatherSignals(weather = {}) {
  const signals = [];
  const t = typeof weather.tempC === "number" ? weather.tempC : null;
  const rain =
    weather.precipitation === "rain" ||
    weather.precipitation === "snow" ||
    /雨|雪/.test(weather.condition || "");

  if (t !== null) {
    if (t <= 10) signals.push({ kind: "temp", value: "hot", weight: 2, reason: `${t}°C 天冷，优先热食热饮` });
    else if (t >= 30) signals.push({ kind: "temp", value: "cold", weight: 2, reason: `${t}°C 天热，优先冰饮清爽路线` });
    else signals.push({ kind: "temp", value: "any", weight: 1, reason: `${t}°C 气温舒适，温度不限` });
  }
  if (rain) signals.push({ kind: "occasion", value: "warm", weight: 1, reason: "有降水，偏向暖胃、汤食类" });
  return signals;
}

/**
 * 星座 → 偏好信号（弱权重，趣味因子）。
 */
export function zodiacSignals(birthday) {
  const z = zodiacOf(birthday);
  if (!z) return [];
  const trait = ELEMENT_TRAIT[z.element];
  return [
    {
      kind: "temp",
      value: trait.temp,
      weight: 1,
      reason: `${z.name}（${z.element}象）：${trait.note}`,
      zodiac: z.name,
      element: z.element,
    },
  ];
}

/**
 * 汇总所有软偏好信号，并给出加权后的温度倾向。
 * @param {object} opts
 * @param {object} [opts.weather]
 * @param {string} [opts.birthday]
 * @param {'hot'|'cold'|'any'} [opts.explicitDrink] 用户显式指定的冷热（用于冲突提示）
 * @returns {{signals:Array, preferredTemp:'hot'|'cold'|'any', reasons:string[], conflict:string|null}}
 */
export function derivePreferences({ weather, birthday, explicitDrink } = {}) {
  const signals = [...weatherSignals(weather || {}), ...zodiacSignals(birthday)];
  const score = { hot: 0, cold: 0, any: 0 };
  for (const s of signals) if (s.kind === "temp") score[s.value] += s.weight;
  let preferredTemp = "any";
  if (score.hot > score.cold) preferredTemp = "hot";
  else if (score.cold > score.hot) preferredTemp = "cold";

  // 冲突检测：显式偏好与天气/星座倾向相反时，诚实告知（硬约束仍以显式偏好为准）
  let conflict = null;
  if (
    explicitDrink &&
    explicitDrink !== "any" &&
    preferredTemp !== "any" &&
    explicitDrink !== preferredTemp
  ) {
    const wantCn = explicitDrink === "hot" ? "热饮" : "冷饮";
    const tendCn = preferredTemp === "hot" ? "热食热饮" : "冰饮清爽";
    conflict = `你指定了${wantCn}，但天气/星座倾向${tendCn}；已按你的显式选择为准。`;
  }

  return {
    signals,
    preferredTemp,
    reasons: signals.map((s) => s.reason),
    conflict,
  };
}

/** 判断星座是否支持（用于 SKILL 文档说明）。 */
export function supportedZodiacs() {
  return ZODIAC.map((z) => ({
    name: z.name,
    element: z.element,
    range: `${String(z.from[0]).padStart(2, "0")}-${String(z.from[1]).padStart(2, "0")} 至 ${String(
      z.to[0]
    ).padStart(2, "0")}-${String(z.to[1]).padStart(2, "0")}`,
  }));
}
