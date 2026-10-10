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
import { scheduleToIcs, toEvent, mergeSchedule, deliveryNote } from "./ics.mjs";
import {
  loadReminders,
  saveReminders,
  remindersPath,
  configureSlots,
  setSlot,
  shouldRemind,
  pauseAll,
  resumeAll,
  skipDay,
  snooze,
  summarize,
  TIME_TEMPLATES,
  REPEAT_RULES,
} from "./reminders.mjs";
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

const line = (n = 56) => "─".repeat(n);

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
  --goal <kcal>         每日热量目标（数值，默认按 TDEE 估算）
  --slots <列表>        要提醒的餐次，逗号分隔：breakfast,lunch,dinner,late-night（默认 lunch）
  --remind <HH:MM>      指定餐次的提醒时间（仅当 --slots 只有一个时有效；
                        多餐次请用 --remind-breakfast / --remind-lunch / --remind-dinner）
  --ics <文件路径>       导出 .ics 日历文件
  --json                输出 JSON
  --demo                强制离线演示（不调 MCP/天气网）

提醒设置（持久化到 ~/.maimen/reminders.json，各餐次独立开关）：
  --setup-reminders     首次设置：确认餐次/时间/时区/重复规则（配 --slots / --remind-<slot>）
  --view-reminders      查看当前提醒设置
  --slot-config <餐次>   修改某餐次的设置（可配 --enable / --disable / --remind-<slot>
                        / --slot-budget <元> / --repeat daily|weekdays|custom / --repeat-days）
  --pause [--until <日期>]  暂停提醒（可指定恢复到哪天）
  --resume              恢复提醒
  --skip-day <日期>      跳过某天（可配 --slot <餐次>，不带则跳过当天全部）
  --snooze <餐次>        延后本次（配 --minutes <分钟>，默认 30）

注意：--training 只接受模板名（fatLoss/muscle/maintain），--goal 只接受数值 kcal。
      两者语义不同，不可混用；写错会直接报错退出，不会静默忽略。

      「周一至周五」不等于法定工作日：调休与节假日需可靠日历来源或用户自定义，
      本工具不做假定，输出里会明示。

示例：
  node cli.mjs --city 上海 --budget 40 --days 7 --ics ./maimen.ics
  node cli.mjs --city 北京 --training fatLoss --weight 58 --goal 1600 --json
  node cli.mjs --setup-reminders --slots breakfast,lunch --remind-lunch 11:45
  node cli.mjs --pause --until 2026-10-07
  node cli.mjs --view-reminders`);
  process.exit(0);
}

// ── 参数校验（--training 与 --goal 语义分离，写错即报错）──
function fail(msg) {
  console.error(`参数错误：${msg}\n用 --help 查看用法。`);
  process.exit(2);
}

const TRAINING_TEMPLATES_KEYS = ["fatLoss", "muscle", "maintain"];
if (args.training != null) {
  if (args.training === true) fail("--training 需要一个模板名");
  if (!TRAINING_TEMPLATES_KEYS.includes(String(args.training))) {
    fail(`--training 只接受 ${TRAINING_TEMPLATES_KEYS.join(" / ")}，收到 "${args.training}"`);
  }
}
if (args.goal != null) {
  if (args.goal === true) fail("--goal 需要一个数值（kcal）");
  const g = Number(args.goal);
  if (!Number.isFinite(g) || g <= 0) fail(`--goal 需要正数 kcal，收到 "${args.goal}"`);
}
for (const [k, min, max] of [
  ["budget", 1, 200],
  ["days", 1, 60],
  ["weight", 20, 300],
  ["height", 100, 250],
  ["age", 10, 100],
]) {
  if (args[k] == null) continue;
  const n = Number(args[k]);
  if (!Number.isFinite(n) || n < min || n > max) fail(`--${k} 应在 ${min}–${max} 之间，收到 "${args[k]}"`);
}
if (args.remind != null && !/^\d{1,2}:\d{2}$/.test(String(args.remind))) {
  fail(`--remind 需形如 HH:MM，收到 "${args.remind}"`);
}

// ══════════════════════════════════════════════════════════
// 提醒设置子命令（需求说明书 §8.1：修改 / 关闭 / 跳过 / 暂停 / 延后）
// 这些命令只读改 ~/.maimen/reminders.json，不跑天气与 MCP。
// ══════════════════════════════════════════════════════════
const REMINDER_SUBCMDS = [
  "setup-reminders",
  "view-reminders",
  "slot-config",
  "pause",
  "resume",
  "skip-day",
  "snooze",
];
const isReminderCommand = REMINDER_SUBCMDS.some((k) => args[k] != null);

if (isReminderCommand) {
  const rs = loadReminders();
  const out = { action: null, before: summarize(rs) };

  // ── 首次设置 ──
  if (args["setup-reminders"] != null) {
    const raw = args.slots != null ? String(args.slots) : "breakfast,lunch,dinner";
    const list = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!list.length) fail("--setup-reminders 需用 --slots 指定至少一个餐次");
    const entries = list.map((slot) => {
      const t = args[`remind-${slot}`] != null ? String(args[`remind-${slot}`]) : null;
      if (t != null && !/^\d{1,2}:\d{2}$/.test(t)) fail(`--remind-${slot} 需形如 HH:MM，收到 "${t}"`);
      // 未显式指定时间时留 undefined：保留已有设置，首次才回落到模板默认值
      return { slot, enabled: true, time: t || undefined };
    });
    const first = !rs.configured;
    const merged = configureSlots(rs, { slots: entries, timezone: args.timezone });
    const saved = saveReminders(merged);
    out.action = "setup";
    out.firstTime = first;
    out.saved = saved;
    out.after = summarize(merged);
    out.message = first
      ? "已完成首次提醒设置。之后修改设置不会重复要求确认。"
      : "已更新提醒设置（已有餐次保留，仅增量合并）。";
  }

  // ── 修改某餐次 ──
  else if (args["slot-config"] != null) {
    const slot = String(args["slot-config"]);
    if (!slot || slot === "true") fail("--slot-config 需要一个餐次名，如 --slot-config lunch");
    const patch = {};
    if (args.enable != null) patch.enabled = true;
    if (args.disable != null) patch.enabled = false;
    const t = args[`remind-${slot}`] != null ? String(args[`remind-${slot}`]) : null;
    if (t != null) {
      if (!/^\d{1,2}:\d{2}$/.test(t)) fail(`--remind-${slot} 需形如 HH:MM，收到 "${t}"`);
      patch.time = t;
    }
    if (args["slot-budget"] != null) {
      const b = Number(args["slot-budget"]);
      if (!Number.isFinite(b) || b <= 0) fail(`--slot-budget 需要正数，收到 "${args["slot-budget"]}"`);
      patch.budget = b;
    }
    if (args.repeat != null) {
      const r = String(args.repeat);
      if (!Object.values(REPEAT_RULES).includes(r)) {
        fail(`--repeat 只接受 ${Object.values(REPEAT_RULES).join(" / ")}，收到 "${r}"`);
      }
      patch.repeat = r;
    }
    if (args["repeat-days"] != null) {
      const days = String(args["repeat-days"])
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
      if (!days.length) fail("--repeat-days 需形如 1,2,3（0=周日 … 6=周六）");
      patch.days = days;
      patch.repeat = REPEAT_RULES.CUSTOM;
    }
    if (!Object.keys(patch).length) fail("--slot-config 需要至少一个改动（--enable/--disable/--remind-<slot>/--slot-budget/--repeat）");
    const merged = setSlot(rs, slot, patch);
    out.saved = saveReminders(merged);
    out.action = "slot-config";
    out.slot = slot;
    out.patch = patch;
    out.after = summarize(merged);
  }

  // ── 暂停全天 ──
  else if (args.pause != null) {
    const until = args.until != null && args.until !== true ? String(args.until) : null;
    if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) fail(`--until 需形如 YYYY-MM-DD，收到 "${until}"`);
    const merged = pauseAll(rs, { from: null, to: until, reason: "用户暂停" });
    out.saved = saveReminders(merged);
    out.action = "pause";
    out.after = summarize(merged);
    out.message = until ? `已暂停提醒，给到 ${until} 为止。` : "已暂停提醒（未设结束日期，用 --resume 恢复）。";
  }

  // ── 恢复 ──
  else if (args.resume != null) {
    const merged = resumeAll(rs);
    out.saved = saveReminders(merged);
    out.action = "resume";
    out.after = summarize(merged);
    out.message = "已恢复提醒。";
  }

  // ── 跳过某天 ──
  else if (args["skip-day"] != null) {
    const date = String(args["skip-day"]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`--skip-day 需形如 YYYY-MM-DD，收到 "${date}"`);
    const slot = args.slot != null && args.slot !== true ? String(args.slot) : null;
    const merged = skipDay(rs, { date, slot });
    out.saved = saveReminders(merged);
    out.action = "skip-day";
    out.message = slot ? `已跳过 ${date} 的「${slot}」。` : `已跳过 ${date} 当天的全部提醒。`;
    out.after = summarize(merged);
  }

  // ── 延后本次 ──
  else if (args.snooze != null) {
    const slot = String(args.snooze);
    if (!slot || slot === "true") fail("--snooze 需要一个餐次名，如 --snooze lunch");
    const minutes = args.minutes != null ? Number(args.minutes) : 30;
    if (!Number.isFinite(minutes) || minutes <= 0) fail(`--minutes 需要正数，收到 "${args.minutes}"`);
    const merged = snooze(rs, { slot, minutes });
    out.saved = saveReminders(merged);
    out.action = "snooze";
    out.until = merged.snooze[slot];
    out.message = `已将「${slot}」本次提醒延后 ${minutes} 分钟（到 ${merged.snooze[slot]}）。`;
    out.after = summarize(merged);
  }

  // ── 查看 ──
  else if (args["view-reminders"] != null) {
    out.action = "view";
    out.after = summarize(rs);
  }

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    printReminderHuman(out);
  }
  process.exit(0);
}

// 餐次定义（需求说明书 §5）：默认午餐；每个餐次有各自的默认提醒时间
const SLOT_DEFS = {
  breakfast: { label: "早餐", time: "07:30", emoji: "🌅" },
  lunch: { label: "午餐", time: "11:30", emoji: "🍟" },
  dinner: { label: "晚餐", time: "18:30", emoji: "🌙" },
  "late-night": { label: "夜宵", time: "22:00", emoji: "🌃" },
  snack: { label: "加餐", time: "15:00", emoji: "🍪" },
};

const slots = (() => {
  const raw = args.slots != null ? String(args.slots) : "lunch";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) fail("--slots 至少要有一个餐次");
  for (const s of list) {
    if (!SLOT_DEFS[s]) fail(`--slots 不支持 "${s}"，可选：${Object.keys(SLOT_DEFS).join(" / ")}`);
  }
  return [...new Set(list)];
})();

/** 取某餐次的提醒时间：优先 --remind-<slot>，其次单餐次时的 --remind，最后默认值。 */
function remindTimeOf(slot) {
  const perSlot = args[`remind-${slot}`];
  if (perSlot != null && /^\d{1,2}:\d{2}$/.test(String(perSlot))) return String(perSlot);
  if (slots.length === 1 && args.remind != null && /^\d{1,2}:\d{2}$/.test(String(args.remind))) {
    return String(args.remind);
  }
  return SLOT_DEFS[slot].time;
}
for (const s of slots) {
  const t = args[`remind-${s}`];
  if (t != null && !/^\d{1,2}:\d{2}$/.test(String(t))) fail(`--remind-${s} 需形如 HH:MM，收到 "${t}"`);
}

const settings = {
  city: args.city || "上海",
  budget: args.budget ? Number(args.budget) : 35,
  days: args.days ? Number(args.days) : 7,
  store: args.store ? String(args.store) : null,
  slots,
  remind: args.remind || SLOT_DEFS[slots[0]].time,
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

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 提醒设置的文字输出。 */
function printReminderHuman(out) {
  const a = out.after || {};
  console.log("⏰ 麦门日历 · 提醒设置");
  console.log(line());
  console.log(`存储：${remindersPath()}`);
  console.log(`时区：${a.timezone || "-"}   首次确认：${a.configured ? "已完成" : "未完成"}`);
  if (a.paused) {
    console.log(`⏸️  已暂停：${a.paused.from || "（即刻）"} → ${a.paused.to || "（未定，用 --resume 恢复）"}`);
  } else {
    console.log("▶️  提醒运行中");
  }
  console.log(line());
  const slots = a.slots || [];
  if (!slots.length) {
    console.log("（尚未配置任何餐次）");
    console.log("  先运行：node cli.mjs --setup-reminders --slots breakfast,lunch,dinner");
  } else {
    console.log("各餐次设置：");
    for (const s of slots) {
      const state = s.enabled ? "✅ 开" : "⛔ 关";
      const budget = s.budget != null ? ` · 预算 ¥${s.budget}` : "";
      const repeat =
        s.repeat === REPEAT_RULES.WEEKDAYS
          ? " · 周一至周五"
          : s.repeat === REPEAT_RULES.CUSTOM
            ? ` · 自定义 ${(s.days || []).map((d) => WEEKDAY_CN[d]).join("/") || "-"}`
            : " · 每天";
      console.log(`   ${state}  ${s.slot.padEnd(10)} ${s.time}${budget}${repeat}`);
    }
  }
  console.log(line());
  if (out.message) console.log(`✔ ${out.message}`);
  if (out.firstTime) {
    console.log("ℹ️  这是首次设置，之后修改不会重复要求确认。");
  }
  for (const w of a.warnings || []) console.log(`⚠️  ${w}`);
  console.log("提醒只提示，不代下单；是否真正弹窗提醒取决于你所用日历/宿主应用。");
}

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
  out.budget = {
    limitYuan: settings.budget,
    hardLimit: true, // 预算为硬上限，任何活动力度都不放宽
    bias: bias.note,
  };

  if (menu) {
    try {
      const norm = normalizeMenuLite(menu);
      // ⚠️ 先过滤"能不能当一顿午饭"，再谈热量和价格。
      // 否则会推荐出"圆筒冰淇淋 ¥5 · 93kcal"这种看似最优、实则荒谬的结果。
      const mealsOnly = norm.filter((m) => isMealWorthy(m.name));
      const inBudget = mealsOnly.filter((m) => m.priceCents <= settings.budget * 100);
      // 预算为硬上限：正餐候选不足时也不放宽到「非正餐」或「超预算」，
      // 有多少合格就用多少；为空则明确返回无解（不回退全菜单）。
      const pool = inBudget.sort((a, b) => a.priceCents - b.priceCents);
      if (pool.length === 0) {
        out.budget.noSolution = true;
        out.budget.reason =
          mealsOnly.length === 0
            ? "该门店菜单里没有可作正餐的候选（可能未取到菜单）"
            : `预算 ${settings.budget} 元内没有可作正餐的候选（最低正餐 ${MONEY(
                Math.min(...mealsOnly.map((m) => m.priceCents))
              )}）`;
        out.warnings.push(`预算内无解：${out.budget.reason}`);
      }
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
  // 摄入热量未知时保留 null（不得按 0 参与计算），并明确告知「无法给出全天结论」
  const intakeKcal =
    out.budget.recommended && Number.isFinite(out.budget.recommended.kcal)
      ? out.budget.recommended.kcal
      : null;
  const target = goalKcal || estimateTdee(profile);
  const intakeSource = intakeKcal === null ? "unknown" : "estimated";
  const bal = balance({
    intakeKcal,
    burnKcal: todayBurn,
    targetKcal: target,
  });
  out.nutrition = {
    profile,
    estimatedGoalKcal: target,
    intakeKcal,
    intakeSource,
    note: goalKcal ? "使用你指定的热量目标" : "按 Mifflin-St Jeor + 轻度活动估算，仅供参照",
    ...bal,
  };
  if (intakeKcal === null) {
    out.nutrition.note += "；本次未取得所选餐品的热量，全天收支结论不可给出";
    out.warnings.push("所选餐品缺少热量数据，已按 unknown 处理，不参与全天收支计算");
  }

  // ── 6. 分餐次吃饭提醒 + 活动日 → 日程 ─────────────────
  // 每个餐次单独成项并带 slot，保证同日早餐/晚餐 UID 不同（需求说明书 §8）
  //
  // §8.1：日程只生成「按提醒设置应当提醒」的餐次。
  //   已保存的提醒设置（~/.maimen/reminders.json）优先于命令行 --slots；
  //   未做任何设置时，按命令行 --slots（默认 lunch）生成，保持向后兼容。
  const remStore = loadReminders();
  const hasReminderConfig = remStore.configured && Object.keys(remStore.slots || {}).length > 0;
  const reminderSkipped = [];
  for (let i = 0; i < settings.days; i++) {
    const d = addDays(today, i);
    const dayScore = scored ? scored.all.find((x) => x.date === d) : null;
    const strength = dayScore
      ? `（今日活动力度：${dayScore.level.emoji} ${dayScore.level.label} ${dayScore.score} 分）`
      : "";
    const weatherNote = i === 0 && out.weather ? `${out.weather.tempC}°C ${out.weather.weather || ""}` : "";
    for (const slot of settings.slots) {
      const def = SLOT_DEFS[slot];
      // 已保存提醒设置时，按 shouldRemind 过滤（未开启 / 暂停 / 跳过 / 周末 / 延后）
      if (hasReminderConfig) {
        const gate = shouldRemind(remStore, slot, d);
        if (!gate.remind) {
          if (!reminderSkipped.some((x) => x.slot === slot && x.reason === gate.reason)) {
            reminderSkipped.push({ slot, date: d, reason: gate.reason });
          }
          continue;
        }
      }
      const showPick = slot === "lunch" || settings.slots.length === 1;
      const savedTime = hasReminderConfig && remStore.slots[slot] && remStore.slots[slot].time
        ? remStore.slots[slot].time
        : null;
      out.schedule.push({
        date: d,
        time: savedTime || remindTimeOf(slot),
        kind: "meal",
        slot,
        title: `${def.emoji} 麦门${def.label}时间${strength}`,
        desc: [
          dayScore ? `活动：${dayScore.title}` : "",
          dayScore ? `力度评分：${dayScore.score}/100（${dayScore.priceLabel}）` : "",
          weatherNote ? `天气：${weatherNote}` : "",
          i === 0 && showPick && out.budget.recommended
            ? `推荐：${out.budget.recommended.name} ${out.budget.recommended.price}`
            : "",
          "提醒：请自行前往麦当劳官方渠道下单（本工具不代下单）。",
        ]
          .filter(Boolean)
          .join("\n"),
        minutes: 20,
        alarmMinutes: 15,
      });
    }
  }
  if (reminderSkipped.length) {
    const uniq = [...new Map(reminderSkipped.map((x) => [`${x.slot}|${x.reason}`, x])).values()];
    for (const x of uniq) {
      out.warnings.push(`提醒设置：${x.slot} 未生成日程（${x.reason}）`);
    }
  }
  if (hasReminderConfig && remStore.paused) {
    out.warnings.push(
      `提醒设置：当前处于暂停状态（${remStore.paused.from || "即刻"} → ${remStore.paused.to || "未定"}）`
    );
  }
  out.reminder = {
    configured: hasReminderConfig,
    source: hasReminderConfig ? "已保存设置（~/.maimen/reminders.json）" : "命令行 --slots（未做持久设置）",
    weekdayOnly: hasReminderConfig
      ? Object.values(remStore.slots).some((c) => c.repeat === REPEAT_RULES.WEEKDAYS)
      : false,
    skipped: [...new Map(reminderSkipped.map((x) => [`${x.slot}|${x.reason}`, x])).values()],
  };
  if (out.reminder.weekdayOnly) {
    out.warnings.push(
      "「周一至周五」不等于法定工作日：调休与节假日需可靠日历来源或用户自定义，本工具不做假定。"
    );
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
          slot: "campaign",
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

  // ── 7. 导出 .ics ─────────────────────────────────────
  // §8.3：同一 date+slot 的「用餐事件」与「活动信息」合并为单条；
  //        不同餐次绝不合并；重复刷新不产生重复事件（靠稳定 UID）。
  if (args.ics) {
    const priority = { campaign: 0, meal: 1, training: 2 };
    const merged = mergeSchedule(out.schedule);
    const ordered = [...merged].sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (priority[a.kind] ?? 9) - (priority[b.kind] ?? 9) ||
        a.time.localeCompare(b.time)
    );
    const ics = scheduleToIcs(ordered, { calendarName: "麦门日历 · 吃与练" });
    writeFileSync(args.ics, ics, "utf8");
    out.icsFile = args.ics;
    out.icsEventCount = ordered.length;
    out.icsMergedFrom = out.schedule.length;
    // §8.2：交付时说明「可承诺 / 不可承诺」，不以文本承诺替代后台能力
    out.delivery = deliveryNote(args.subscribe ? "subscription" : "ics");
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

  if (out.reminder) {
    console.log(`⏰ 提醒设置：${out.reminder.source}`);
    if (out.reminder.weekdayOnly) {
      console.log("   ⚠️ 「周一至周五」≠ 法定工作日（调休/节假日需可靠来源或自定义）");
    }
    if (out.reminder.skipped.length) {
      for (const x of out.reminder.skipped.slice(0, 4)) {
        console.log(`   · ${x.slot} 未生成：${x.reason}`);
      }
    }
    console.log(line());
  }

  console.log(`🗓️  日程（${out.schedule.length} 项）`);
  for (const e of out.schedule.slice(0, 10)) {
    const icon = e.kind === "meal" ? "🍽️" : e.kind === "training" ? "🏃" : "🎉";
    console.log(`   ${e.date} ${e.time} ${icon} ${e.title}`);
  }
  if (out.schedule.length > 10) console.log(`   …还有 ${out.schedule.length - 10} 项`);
  console.log(line());

  if (out.icsFile) {
    console.log(`✅ 已导出日历：${out.icsFile}（双击导入苹果/谷歌/Outlook 日历）`);
    if (out.icsMergedFrom != null && out.icsMergedFrom !== out.icsEventCount) {
      console.log(`   · 已合并同日同餐次事件：${out.icsMergedFrom} → ${out.icsEventCount} 条`);
    }
    if (out.delivery) {
      console.log(`   · 交付方式：${out.delivery.label}`);
      console.log(`   · 可承诺：${out.delivery.canPromise.join("；")}`);
      console.log(`   · 不可承诺：${out.delivery.cannotPromise.join("；")}`);
      console.log(`   · ${out.delivery.note}`);
    }
  }
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
