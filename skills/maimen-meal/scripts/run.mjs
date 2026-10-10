#!/usr/bin/env node
/**
 * 麦门这一餐 —— Skill 主入口
 *
 * 用法：
 *   node run.mjs --budget 30 --slot lunch --purpose full-meal --city 上海
 *   node run.mjs --budget 25 --drink hot --no-spicy --birthday 2000-08-15
 *   node run.mjs --weather '{"tempC":5,"precipitation":"rain"}' --json
 *   node run.mjs --demo --budget 20            # 强制演示数据
 *   node run.mjs --store 1400685 --budget 40   # 指定真实门店
 *
 * 有 MCD_MCP_TOKEN 时走真实 MCP：查门店 → 查真实菜单 → 候选组装 → 服务端核价。
 * 无 Token 时使用演示数据，并把来源标为 demo（不伪装成真实结果）。
 */
import { recommend, DEMO_MEALS, DEFAULT_SETTINGS, MEAL_SLOTS, MEAL_PURPOSES, inferSlot } from "./recommend.mjs";
import { derivePreferences, supportedZodiacs } from "./preference.mjs";
import {
  hasMcp,
  mcd,
  normalizeMenu,
  buildCandidates,
  itemsForCandidate,
  comparePrices,
} from "./mcp.mjs";
import { loadMemory, saveMemory, recordSelection, memoryForRecommend } from "./memory.mjs";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else out._.push(a);
  }
  return out;
}

function parseWeather(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    const [temp, precip] = String(raw).split(",");
    return { tempC: Number(temp), precipitation: precip || undefined };
  }
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  console.log(`麦门这一餐 · 今天吃什么 Skill

参数：
  --budget <元>            本餐预算上限（硬上限，默认 ${DEFAULT_SETTINGS.budget}）
  --slot <餐次>            breakfast | lunch | dinner | late-night | snack（默认按当前时间）
  --purpose <目的>         full-meal | light-meal | drink-only（默认 full-meal）
  --drink <any|hot|cold>   冷热饮偏好（默认 any）
  --no-spicy               不吃辣
  --city <城市>            常用城市（默认 上海）
  --birthday <YYYY-MM-DD>  生日，用于星座偏好映射
  --weather <json|"温,降水"> 今日天气，如 {"tempC":5,"precipitation":"rain"}
  --store <门店ID>         指定真实门店 storeCode（跳过门店查询）
  --no-memory              本次不读取也不写入历史记忆
  --json                   以 JSON 输出
  --demo                   强制使用演示数据（即使有 Token）
  --zodiacs                列出支持的星座

环境变量：
  MCD_MCP_TOKEN            麦当劳 MCP Token（不填则用演示数据）
  MCD_MCP_URL              接入地址（默认 https://mcp.mcd.cn）
  MAIMEN_MEMORY_PATH       记忆文件路径（默认 ~/.maimen/memory.json）

示例：
  node run.mjs --budget 25 --slot lunch --drink hot --no-spicy
  node run.mjs --slot breakfast --purpose light-meal --json`);
  process.exit(0);
}

if (args.zodiacs) {
  console.log(JSON.stringify(supportedZodiacs(), null, 2));
  process.exit(0);
}

// ── 参数校验 ─────────────────────────────────────────
function fail(msg) {
  console.error(`参数错误：${msg}\n用 --help 查看用法。`);
  process.exit(2);
}
if (args.slot != null && args.slot !== true && !MEAL_SLOTS[String(args.slot)]) {
  fail(`--slot 只接受 ${Object.keys(MEAL_SLOTS).join(" / ")}，收到 "${args.slot}"`);
}
if (args.purpose != null && args.purpose !== true && !MEAL_PURPOSES[String(args.purpose)]) {
  fail(`--purpose 只接受 ${Object.keys(MEAL_PURPOSES).join(" / ")}，收到 "${args.purpose}"`);
}
if (args.budget != null) {
  const b = Number(args.budget);
  if (!Number.isFinite(b) || b <= 0 || b > 200) fail(`--budget 应在 1–200 元之间，收到 "${args.budget}"`);
}

const money = (cents) =>
  cents === null || cents === undefined || !Number.isFinite(cents) ? "价格未知" : `¥${(cents / 100).toFixed(2)}`;

async function main() {
  const slot = args.slot && MEAL_SLOTS[String(args.slot)] ? String(args.slot) : inferSlot();
  const purpose =
    args.purpose && MEAL_PURPOSES[String(args.purpose)]
      ? String(args.purpose)
      : MEAL_SLOTS[slot].defaultPurpose;

  const settings = {
    ...DEFAULT_SETTINGS,
    budget: args.budget ? Number(args.budget) : DEFAULT_SETTINGS.budget,
    drink: ["any", "hot", "cold"].includes(args.drink) ? args.drink : "any",
    noSpicy: Boolean(args["no-spicy"]),
    city: args.city || DEFAULT_SETTINGS.city,
    mealSlot: slot,
    mealPurpose: purpose,
  };
  const weather = parseWeather(args.weather);
  const birthday = args.birthday || null;
  const preference = derivePreferences({ weather, birthday, explicitDrink: settings.drink });
  const budgetCents = Math.round(settings.budget * 100);

  // ── 记忆（持久化读取）──────────────────────────────
  const useMemory = !args["no-memory"];
  const mem = useMemory ? loadMemory() : { version: 1, selections: [], feedback: {} };
  const { history, excluded, lastPick } = useMemory
    ? memoryForRecommend(mem, { slot })
    : { history: [], excluded: new Set(), lastPick: null };

  // ── 数据源：真实 MCP 优先 ───────────────────────────
  // status: verified=真实核价可用 / demo=演示数据 / failed=服务失败 / no-solution=业务无解
  let dataStatus = "demo";
  let failureNote = null;
  let store = null;
  let meals = DEMO_MEALS;
  let storeSource = "demo";
  let menuSource = "demo";
  let priceComparison = null;
  let noSolutionReason = null;

  if (hasMcp() && !args.demo) {
    try {
      // ① 门店（不默认取第一项为「最近」；无 --store 时取首个作为候选并标注）
      if (args.store) {
        store = { storeCode: String(args.store), storeName: "指定门店" };
        storeSource = "mcp:query-nearby-stores(指定)";
      } else {
        const stores = await mcd.nearbyStores({ city: settings.city, searchType: 1 });
        const list = Array.isArray(stores) ? stores : [];
        if (!list.length) throw new Error("未取到门店");
        // ⚠️ 接口未承诺排序语义，这里只取第一个作为「候选」并在输出里标注需用户确认
        store = list[0];
        storeSource = "mcp:query-nearby-stores(候选首项，需用户确认)";
      }
      if (!store || !store.storeCode) throw new Error("未取到门店");

      // ② 真实菜单
      const rawMenu = await mcd.meals({ storeCode: store.storeCode });
      const menu = normalizeMenu(rawMenu);
      if (!menu.length) throw new Error("菜单为空");
      menuSource = "mcp:query-meals";

      // ③ 候选组装（预算硬上限；为空即业务无解，不回退全菜单）
      const candidates = buildCandidates(menu, budgetCents);
      if (!candidates.length) {
        noSolutionReason = `预算 ${money(budgetCents)} 内没有可作一餐的候选`;
        dataStatus = "no-solution";
      } else {
        // ④ 硬约束 + 软偏好筛选（含餐次/目的）
        const pre = recommend({
          settings,
          meals: candidates.map((c) => ({
            id: c.code,
            name: c.name,
            main: c.main || c.name,
            side: c.category,
            drink: c.drink ? c.name : "",
            temp: c.temp || "any",
            price: c.price,
            spicy: c.spicy,
            isCombo: c.isCombo,
          })),
          history,
          previous: lastPick,
          preference,
          excluded,
        });

        if (!pre.meal) {
          noSolutionReason = pre.emptyReason || "当前条件下无可行方案";
          dataStatus = "no-solution";
        } else {
          // ⑤ 只对「最终进入推荐的候选」做服务端核价，保证核价集合 == 最终过滤集合
          const target = candidates.find((c) => c.code === pre.meal.id);
          const shortlist = (target ? [target] : []).map((c) => ({
            label: c.name,
            items: itemsForCandidate(c),
            detail: c,
          }));
          if (shortlist.length) {
            priceComparison = await comparePrices(shortlist, { storeCode: store.storeCode });
          }
          meals = candidates;
          dataStatus = priceComparison && priceComparison.status === "verified" ? "verified" : "verified-unpriced";
          runResult = pre;
        }
      }
    } catch (e) {
      // 区分「传输失败」与「业务失败」，不回退演示、不伪装成真实精算
      dataStatus = "failed";
      failureNote = `${e.kind === "transport" ? "服务不可达" : "调用失败"}：${e.message}`;
    }
  }

  let runResult = null;
  if (!runResult) {
    runResult = recommend({
      settings,
      meals,
      history,
      previous: lastPick,
      preference,
      excluded,
    });
    if (!runResult.meal && !noSolutionReason) noSolutionReason = runResult.emptyReason;
  }
  const finalMeal = runResult.meal;

  // ── 记录本次选择（持久化写入）──────────────────────
  if (useMemory && finalMeal && dataStatus !== "failed") {
    recordSelection(mem, {
      slot,
      purpose,
      id: finalMeal.id,
      name: finalMeal.name,
      priceCents: finalMeal.price,
      status: dataStatus,
    });
    saveMemory(mem);
  }

  // 把核价结论融进理由（按对象标记来源，不写死文案）
  const extraReasons = [];
  if (priceComparison && finalMeal) {
    const mine = priceComparison.all.find((r) => r.label === finalMeal.name);
    if (mine && mine.status === "verified") {
      extraReasons.push(`服务端实付核价 ${money(mine.payableCents)}（已验证）`);
    } else if (mine && mine.status === "failed") {
      extraReasons.push(`服务端核价未成功（${mine.error || "未知原因"}），以下价格以菜单标价为准`);
    }
  }

  // ── 输出合同（见 references/output-contract.md）──────
  const sources = {
    store: { source: storeSource, status: store ? (dataStatus === "failed" ? "unknown" : "verified") : "unknown", scope: store ? `store=${store.storeCode}` : "global" },
    menu: { source: menuSource, status: dataStatus === "demo" ? "demo" : dataStatus === "failed" ? "unknown" : "verified", scope: store ? `store=${store.storeCode}` : "global" },
    price: {
      source: "mcp:calculate-price",
      status: priceComparison ? priceComparison.status : "unknown",
      scope: store ? `store=${store.storeCode}` : "global",
      validFor: "单次询价，付款前请以官方渠道为准",
    },
    weather: { source: weather ? "参数传入" : "未提供", status: weather ? "verified" : "unknown", scope: "day" },
    memory: { source: "本地记忆文件", status: useMemory && history.length ? "verified" : "unknown", scope: `slot=${slot}` },
  };

  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      tool: "maimen-meal",
      version: "2.0",
    },
    context: {
      slot,
      slotLabel: MEAL_SLOTS[slot].label,
      purpose,
      purposeLabel: MEAL_PURPOSES[purpose].label,
      store: store ? { storeCode: store.storeCode, storeName: store.storeName } : null,
    },
    constraints: runResult.constraints,
    sources,
    recommendation: finalMeal
      ? {
          id: finalMeal.id,
          name: finalMeal.name,
          priceCents: finalMeal.price,
          price: money(finalMeal.price),
          priceStatus: finalMeal.price === null ? "unknown" : "verified",
          category: finalMeal.category || finalMeal.side || "",
          temp: finalMeal.temp || "any",
        }
      : null,
    comparison: priceComparison
      ? {
          status: priceComparison.status,
          best: priceComparison.best
            ? { label: priceComparison.best.label, payableCents: priceComparison.best.payableCents, payable: money(priceComparison.best.payableCents) }
            : null,
          all: priceComparison.all.map((r) => ({
            label: r.label,
            payableCents: r.payableCents,
            payable: r.payableCents != null ? money(r.payableCents) : null,
            status: r.status,
            error: r.error || null,
          })),
        }
      : null,
    reasons: [...runResult.reasons, ...extraReasons],
    memory: {
      used: useMemory,
      historyCount: history.length,
      lastPick,
      excludedCount: excluded.size,
    },
    reminder: finalMeal
      ? { note: "本工具只询价、不创建订单、不付款；请自行前往麦当劳官方渠道下单。" }
      : null,
    warnings: [
      ...(failureNote ? [failureNote] : []),
      ...(noSolutionReason ? [`无解：${noSolutionReason}`] : []),
      ...(dataStatus === "demo" ? ["当前使用演示数据，非真实门店报价"] : []),
      ...(store && !args.store ? ["门店为候选首项，接口未承诺排序语义，请确认是否为你常用的门店"] : []),
    ],
    dataStatus,
    eligibleCount: runResult.count,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const slotDef = MEAL_SLOTS[slot];
  console.log(`${slotDef.label === "加餐" ? "🍪" : slotDef.label === "早餐" ? "🌅" : slotDef.label === "晚餐" ? "🌙" : slotDef.label === "夜宵" ? "🌃" : "🍟"} 麦门这一餐 · ${slotDef.label}建议`);
  console.log("─".repeat(44));
  console.log(`数据状态：${dataStatus}`);
  if (store) console.log(`门店：${store.storeName}（${store.storeCode}）`);
  console.log(`餐次：${slotDef.label} · 目的：${MEAL_PURPOSES[purpose].label}`);
  console.log(
    `预算硬上限：${money(budgetCents)} · 冷热：${settings.drink} · ${settings.noSpicy ? "不吃辣" : "不限辣"}`
  );
  if (preference.signals.length) {
    console.log("偏好信号：");
    for (const s of preference.signals) console.log(`  · ${s.reason}`);
  }
  if (preference.conflict) console.log(`⚠️  ${preference.conflict}`);
  console.log("─".repeat(44));

  if (priceComparison && priceComparison.all.length) {
    console.log("💱 服务端核价：");
    for (const r of priceComparison.all) {
      if (r.status === "failed") {
        console.log(`   ✗ ${r.label} → ${r.error || "核价失败"}`);
        continue;
      }
      console.log(`   ${r.label}：${money(r.payableCents)}${r.status === "verified" ? " ✓已验证" : ""}`);
    }
    console.log("─".repeat(44));
  }

  if (!finalMeal) {
    console.log(`⚠️  ${noSolutionReason || "当前条件下没有可行方案，试试放宽预算或调整偏好。"}`);
    if (runResult && runResult.count === 0) console.log("   （预算为硬上限，不会自动放宽）");
  } else {
    console.log(`👉 ${finalMeal.name}`);
    if (finalMeal.category) console.log(`   分类：${finalMeal.category}`);
    console.log(`   标价：${money(finalMeal.price)}（符合条件共 ${runResult.count} 套）`);
    console.log("   理由：");
    for (const r of payload.reasons) console.log(`     · ${r}`);
  }
  console.log("─".repeat(44));
  for (const w of payload.warnings) console.log(`⚠️  ${w}`);
  console.log("非官方应用 · 只询价不下单不付款 · 价格以麦当劳官方渠道为准");
}

main().catch((e) => {
  console.error("运行失败：", e.message);
  process.exit(1);
});
