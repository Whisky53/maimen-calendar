#!/usr/bin/env node
/**
 * 麦门日历 · 主入口
 *
 * 六大能力：
 *   1. 天气      中国天气网实时+预报+生活指数，温度分层规则
 *   2. 活动力度  真实 campaign-calendar + 门店券 → 每日力度评分
 *   3. 提醒      吃饭提醒 / 训练提醒（只提醒，绝不自动下单）
 *   4. 日历      导出 .ics（苹果/谷歌/Outlook 通用）+ 订阅链接
 *   5. 热量      真实营养表 + 训练消耗收支平衡
 *   6. 训练计划  周模板展开 + 热量联动
 *
 * 用法：
 *   node cli.mjs --city 上海 --budget 40
 *   node cli.mjs --city 上海 --days 7 --ics out.ics
 *   node cli.mjs --city 上海 --training fatLoss --weight 60 --json
 *   node cli.mjs --help
 */
import { cityCodeOf, weatherInput, weatherPolicy, realtime, forecast } from "./weather.mjs";
import { hasMcp, fetchCalendar, mcd, nutritionMap, lookupKcal } from "./mcd.mjs";
import { scoreCalendar, levelToBias, todayStr } from "./campaign.mjs";
import {
  burnOfPlan,
  balance,
  nutritionScore,
  TRAINING_TEMPLATES,
  expandPlan,
  MET_TABLE,
} from "./nutrition.mjs";
import { scheduleToIcs, toEvent } from "./ics.mjs";
import { writeFileSync } from "node:fs";

const MONEY = (c) => `¥${(c / 100).toFixed(2)}`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) {
        out[k] = v;
        i++;
      } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  console.log(`麦门日历 · 用法

参数：
  --city <城市>         城市（默认 上海）
  --budget <元>         午餐预算（默认 35）
  --days <N>            规划天数（默认 7）
  --store <storeCode>   指定真实门店，跳过门店查询
  --training <模板>     训练计划：fatLoss / muscle / maintain
  --weight <kg>         体重，用于训练消耗估算（默认 60）
  --height <cm>         身高（默认 168）
  --age <岁>            年龄（默认 30）
  --gender <male|female> 性别（默认 female）
  --goal <kcal>         每日热量目标（默认按 TDEE 估算）
  --remind <HH:MM>      吃饭提醒时间（默认 11:30）
  --ics <文件路径>       导出 .ics 日历文件
  --json                输出 JSON
  --demo                强制离线演示（不调 MCP/天气网）

示例：
  node cli.mjs --city 上海 --budget 40 --days 7 --ics ./maimen.ics
  node cli.mjs --city 北京 --training fatLoss --weight 58 --goal 1600 --json`);
  process.exit(0);
}

const settings = {
  city: args.city || "上海",
  budget: args.budget ? Number(args.budget) : 35,
  days: args.days ? Number(args.days) : 7,
  store: args.store ? String(args.store) : null,
  remind: args.remind || "11:30",
  demo: Boolean(args.demo),
};

const profile = {
  gender: args.gender === "male" ? "male" : "female",
  weightKg: args.weight ? Number(args.weight) : 60,
  heightCm: args.height ? Number(args.height) : 168,
  age: args.age ? Number(args.age) : 30,
  activityFactor: 1.375,
};

const trainingTplKey = args.training || null;
const goalKcal = args.goal ? Number(args.goal) : null;

const line = (n = 56) => "─".repeat(n);

async function main() {
  const out = {
    generatedAt: new Date().toISOString(),
    city: settings.city,
    sources: {},
    weather: null,
    weatherSignals: [],
    campaign: null,
    budget: null,
    nutrition: null,
    training: null,
    schedule: [],
    warnings: [],
  };

  // ── 1. 天气（中国天气网） ─────────────────────────────
  let weather = null;
  if (!settings.demo) {
    try {
      weather = await weatherInput(settings.city);
      if (weather) out.sources.weather = "中国天气网";
    } catch (e) {
      out.warnings.push(`天气获取失败，已跳过：${e.message}`);
    }
  }
  if (!weather) {
    weather = { city: settings.city, tempC: 22, precipitation: "none", condition: "未知", source: "本地默认" };
    out.sources.weather = "本地默认（离线）";
  }
  out.weather = {
    city: weather.city,
    tempC: weather.tempC,
    weather: weather.weather,
    precipitation: weather.precipitation,
    aqi: weather.aqi,
  };
  out.weatherSignals = weatherPolicy(weather);

  // ── 2. 活动日历（麦当劳 MCP） ─────────────────────────
  let scored = null;
  let store = null;
  let menu = null;
  let kcalMap = null;

  if (hasMcp() && !settings.demo) {
    try {
      // 门店
      if (settings.store) store = { storeCode: settings.store, storeName: "指定门店" };
      else {
        const stores = await mcd.nearbyStores({ city: settings.city, searchType: 1 });
        store = Array.isArray(stores) ? stores[0] : null;
      }

      // 活动日历
      const cal = await fetchCalendar();
      scored = scoreCalendar(cal, { limit: 5 });
      out.sources.campaign = "麦当劳 MCP campaign-calendar";

      // 门店券
      let coupons = [];
      if (store && store.storeCode) {
        try {
          const c = await mcd.storeCoupons({ storeCode: store.storeCode });
          coupons = Array.isArray(c) ? c : [];
        } catch {
          /* 券查询失败不影响主流程 */
        }
        if (coupons.length) {
          out.sources.coupons = `query-store-coupons（${coupons.length} 张）`;
          scored = scoreCalendar(cal, { coupons, limit: 5 });
        }
      }

      // 营养表
      try {
        const nm = await nutritionMap();
        kcalMap = nm.map;
        out.sources.nutrition = `list-nutrition-foods（${nm.list.length} 条）`;
      } catch (e) {
        out.warnings.push(`营养表获取失败：${e.message}`);
      }

      // 菜单（用于预算内推荐）
      if (store && store.storeCode) {
        try {
          menu = await mcd.meals({ storeCode: store.storeCode });
        } catch (e) {
          out.warnings.push(`菜单获取失败：${e.message}`);
        }
      }
    } catch (e) {
      out.warnings.push(`MCP 数据获取失败：${e.message}`);
    }
  }

  out.campaign = scored
    ? {
        today: scored.today,
        best: scored.best,
        top: scored.top.map((d) => ({ date: d.date, score: d.score, level: d.level.label, title: d.title })),
      }
    : null;

  // ── 3. 训练计划（先算，供热量/候选联动） ───────────────
  const today = todayStr();
  const endDate = addDays(today, settings.days - 1);

  if (trainingTplKey && TRAINING_TEMPLATES[trainingTplKey]) {
    const tpl = TRAINING_TEMPLATES[trainingTplKey];
    const plan = expandPlan(tpl, today, endDate);
    out.training = {
      template: tpl.label,
      sessions: plan.map((p) => {
        const burn = burnOfPlan([{ ...p, weightKg: profile.weightKg }]);
        return { date: p.date, type: p.label, minutes: p.minutes, burnKcal: burn.total };
      }),
    };
    for (const s of out.training.sessions) {
      out.schedule.push({
        date: s.date,
        time: "19:30",
        kind: "training",
        title: `🏃 ${s.type} ${s.minutes} 分钟`,
        desc: `预计消耗约 ${s.burnKcal} kcal（MET 估算）`,
        minutes: s.minutes,
        alarmMinutes: 30,
      });
    }
  }
  const todayBurn = out.training
    ? out.training.sessions.filter((s) => s.date === today).reduce((a, b) => a + b.burnKcal, 0)
    : 0;

  // ── 4. 预算内套餐 + 热量（结合今日力度与训练量） ───────
  const todayLevel = (scored && scored.today && scored.today.level) || null;
  const bias = levelToBias(todayLevel);
  out.budget = { limitYuan: settings.budget, bias: bias.note };

  if (menu) {
    try {
      const norm = normalizeMenuLite(menu);
      // ⚠️ 先过滤"能不能当一顿午饭"，再谈热量和价格。
      // 否则会推荐出"圆筒冰淇淋 ¥5 · 93kcal"这种看似最优、实则荒谬的结果。
      const mealsOnly = norm.filter((m) => isMealWorthy(m.name));
      const inBudget = mealsOnly.filter((m) => m.priceCents <= settings.budget * 100);
      const pool = (inBudget.length >= 3 ? inBudget : norm.filter((m) => m.priceCents <= settings.budget * 100))
        .sort((a, b) => a.priceCents - b.priceCents);
      const picks = pool.slice(0, 14).map((c) => {
        const nut = kcalMap ? lookupKcal(kcalMap, c.name) : null;
        // 训练日适当抬高一餐能量下限（练了要补）
        const minKcal = todayBurn > 200 ? 450 : 350;
        const ns = nutritionScore(nut, { maxKcal: goalKcal || null, minKcal, minProtein: 20 });
        return { ...c, kcal: nut ? nut.kcal : null, protein: nut ? nut.protein : null, nutritionScore: ns.score, nutritionReasons: ns.reasons };
      });
      picks.sort((a, b) => b.nutritionScore - a.nutritionScore || a.priceCents - b.priceCents);
      out.budget.candidates = picks.slice(0, 8).map((p) => ({
        name: p.name,
        price: MONEY(p.priceCents),
        kcal: p.kcal,
        protein: p.protein,
        note: p.nutritionReasons.join("；"),
      }));
      out.budget.recommended = picks[0]
        ? { name: picks[0].name, price: MONEY(picks[0].priceCents), kcal: picks[0].kcal, protein: picks[0].protein }
        : null;
    } catch (e) {
      out.warnings.push(`候选套餐计算失败：${e.message}`);
    }
  }

  // ── 5. 热量收支 ──────────────────────────────────────
  const intakeKcal = out.budget.recommended && out.budget.recommended.kcal ? out.budget.recommended.kcal : null;
  const target = goalKcal || estimateTdee(profile);
  out.nutrition = {
    profile,
    estimatedGoalKcal: target,
    note: goalKcal ? "使用你指定的热量目标" : "按 Mifflin-St Jeor + 轻度活动估算，仅供参照",
    ...balance({
      intakeKcal: intakeKcal || 0,
      burnKcal: todayBurn,
      targetKcal: target,
    }),
  };

  // ── 5. 吃饭提醒 + 活动日 → 日程 ───────────────────────
  for (let i = 0; i < settings.days; i++) {
    const d = addDays(today, i);
    const dayScore = scored ? scored.all.find((x) => x.date === d) : null;
    const strength = dayScore ? `（今日活动力度：${dayScore.level.emoji} ${dayScore.level.label} ${dayScore.score} 分）` : "";
    const weatherNote = i === 0 ? `${out.weather.tempC}°C ${out.weather.weather || ""}` : "";
    out.schedule.push({
      date: d,
      time: settings.remind,
      kind: "meal",
      title: `🍟 麦门午饭时间${strength}`,
      desc: [
        dayScore ? `活动：${dayScore.title}` : "",
        dayScore ? `力度评分：${dayScore.score}/100（${dayScore.priceLabel}）` : "",
        weatherNote ? `天气：${weatherNote}` : "",
        i === 0 && out.budget.recommended ? `推荐：${out.budget.recommended.name} ${out.budget.recommended.price}` : "",
        "提醒：请自行前往麦当劳官方渠道下单（本工具不代下单）。",
      ]
        .filter(Boolean)
        .join("\n"),
      minutes: 20,
      alarmMinutes: 15,
    });
  }

  // 高力度活动日额外加事件。
  // 门槛对齐 5 档体系：只给「值得去(good)」及以上（≥60 分）单独建事件，
  // 「小惊喜/平平/无活动」不打扰用户——那天照样会走常规午饭提醒。
  if (scored) {
    for (const d of scored.all) {
      if (d.date < today || d.date > endDate) continue;
      if (d.isPast) continue;
      if (d.level.key === "great" || d.level.key === "good") {
        out.schedule.push({
          date: d.date,
          time: "10:00",
          kind: "campaign",
          title: `${d.level.emoji} 麦当劳活动：${d.title.slice(0, 24)}`,
          desc: [`力度：${d.score}/100（${d.level.label}）`, ...d.reasons.slice(0, 4)].join("\n"),
          minutes: 30,
          alarmMinutes: 0,
        });
      }
    }
  }

  // 排序日程
  out.schedule.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  // ── 6. 导出 .ics ─────────────────────────────────────
  if (args.ics) {
    const priority = { campaign: 0, meal: 1, training: 2 };
    const ordered = [...out.schedule].sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (priority[a.kind] ?? 9) - (priority[b.kind] ?? 9) ||
        a.time.localeCompare(b.time)
    );
    const ics = scheduleToIcs(ordered, { calendarName: "麦门日历 · 麦门午饭与训练" });
    writeFileSync(args.ics, ics, "utf8");
    out.icsFile = args.ics;
  }

  // ── 输出 ─────────────────────────────────────────────
  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  printHuman(out, settings, store);
}

function printHuman(out, s, store) {
  console.log("🍟 麦门日历 · 今日与未来规划");
  console.log(line());
  console.log(`城市：${out.weather.city}  ·  天气来源：${out.sources.weather || "-"}`);
  const w = out.weather;
  console.log(`实况：${w.tempC}°C ${w.weather || ""}${w.aqi ? ` · AQI ${w.aqi}` : ""}`);
  for (const sig of out.weatherSignals) console.log(`  · ${sig.reason}`);
  console.log(line());

  if (out.campaign) {
    console.log("📅 活动力度评分（真实活动日历）");
    if (store) console.log(`   门店：${store.storeName || store.storeCode}`);
    if (out.campaign.today) {
      const t = out.campaign.today;
      console.log(`   今天：${t.level.emoji} ${t.level.label} ${t.score}/100 · ${t.priceLabel}`);
      console.log(`   主活动：${t.title}`);
    }
    console.log("   未来最值得吃：");
    for (const d of out.campaign.top) {
      console.log(`     ${d.date}  ${String(d.score).padStart(3)} 分 ${d.level}  ${d.title.slice(0, 30)}`);
    }
    console.log(line());
  }

  if (out.budget && out.budget.candidates && out.budget.candidates.length) {
    console.log(`💰 预算内候选（≤${MONEY(out.budget.limitYuan * 100)}）`);
    console.log(`   ${out.budget.bias}`);
    for (const c of out.budget.candidates.slice(0, 5)) {
      const kcal = c.kcal ? ` · ${c.kcal} kcal` : "";
      console.log(`   ${c.name}  ${c.price}${kcal}`);
    }
    if (out.budget.recommended) {
      console.log(`   👉 推荐：${out.budget.recommended.name} ${out.budget.recommended.price}`);
    }
    console.log(line());
  }

  if (out.training) {
    console.log(`🏃 训练计划（${out.training.template}）`);
    for (const s of out.training.sessions.slice(0, 8)) {
      console.log(`   ${s.date}  ${s.type} ${s.minutes}分钟 → 约消耗 ${s.burnKcal} kcal`);
    }
    console.log(line());
  }

  console.log("⚖️  热量收支");
  console.log(`   目标摄入：${out.nutrition.estimatedGoalKcal} kcal（${out.nutrition.note}）`);
  console.log(`   摄入 ${out.nutrition.intakeKcal} − 消耗 ${out.nutrition.burnKcal} = 净 ${out.nutrition.netKcal} kcal`);
  if (out.nutrition.verdictNote) console.log(`   ${out.nutrition.verdictNote}`);
  console.log(line());

  console.log(`🗓️  日程（${out.schedule.length} 项）`);
  for (const e of out.schedule.slice(0, 10)) {
    const icon = e.kind === "meal" ? "🍽️" : e.kind === "training" ? "🏃" : "🎉";
    console.log(`   ${e.date} ${e.time} ${icon} ${e.title}`);
  }
  if (out.schedule.length > 10) console.log(`   …还有 ${out.schedule.length - 10} 项`);
  console.log(line());

  if (out.icsFile) console.log(`✅ 已导出日历：${out.icsFile}（双击导入苹果/谷歌/Outlook 日历）`);
  for (const w of out.warnings) console.log(`⚠️  ${w}`);
  console.log("非官方应用 · 只提醒不下单 · 力度评分为估算 · 热量以麦当劳官方营养表为准");
}

/**
 * 判断一个商品能不能当"一顿午饭"。
 *
 * 逻辑分三层，顺序很重要：
 *   1) 是不是"套餐/组合"（含堡/三件套/拼盘等）→ 直接算正餐
 *   2) 是不是明确的非正餐（饮品/甜点/酱/周边/配菜）→ 直接排除
 *   3) 其余按正餐关键词判断
 */
function isMealWorthy(name = "") {
  const n = String(name);
  // ① 套餐 / 组合类：一定是正餐
  if (/套餐|三件套|四件套|双人餐|单人餐|拼盘|随心拼|双全盒|桶/.test(n)) return true;

  // ② 明确的非正餐（饮品、甜点、酱料、周边、单配菜）
  const NOT_MEAL =
    /冰淇淋|新地|麦旋风|圣代|圆筒|^派$|派$|饼干|蘸酱|酱|周边|公仔|玩具|苹果片|玉米杯|脆薯饼|薯饼|^饮料$|纯悦|可乐|雪碧|红茶|咖啡|拿铁|美式|摩卡|奶茶|牛奶|果汁|豆浆|^水$|沙拉|鸡排|鸡块$/.test(
      n
    );
  if (NOT_MEAL) return false;

  // ③ 正餐特征：汉堡/鸡肉类/卷/饭/牛鱼/薯条等
  return /堡|鸡|卷|饭|牛|鱼|薯条|麦乐鸡|套餐|块/.test(n);
}

// ---- 工具函数 ----

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function estimateTdee(p) {
  const base = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age;
  const bmr = p.gender === "male" ? base + 5 : base - 161;
  return Math.round(bmr * p.activityFactor);
}

/** 轻量菜单归一化（从 query-meals 原始结构取 name + 价格）。 */
function normalizeMenuLite(raw) {
  if (!raw) return [];
  const mapping = raw.meals && typeof raw.meals === "object" ? raw.meals : null;
  const out = [];
  if (mapping) {
    for (const [code, m] of Object.entries(mapping)) {
      const yuan = Number(m.currentPrice ?? 0) || 0;
      out.push({ code, name: m.name || `餐品${code}`, priceCents: Math.round(yuan * 100) });
    }
  }
  return out;
}

main().catch((e) => {
  console.error("运行失败：", e.message);
  process.exit(1);
});
