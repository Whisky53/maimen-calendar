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
import { recommendLive } from "./live-recommend.mjs";
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
import {
  loadMemory,
  saveMemory,
  appendEvent,
  makeEvent,
  deterministicId,
  listEvents,
  revokeFeedback,
  clearMemory,
  exportMemory,
  purgeExpired,
  memoryForRecommend,
  trendReport,
  updateConfirmed,
  recordInferred,
  EVENT_TYPES,
  FEEDBACK_VERDICTS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_WINDOW_DAYS,
} from "./memory.mjs";

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

记忆管理（需求说明书 §7）：
  --record consumed        记「已吃过」（也能用 --record selected / rerolled / skipped）
  --record-id <id>         配合 --record 指定餐品 id（默认取上次推荐）
  --feedback <verdict>     记反馈：like | dislike | too_spicy | too_expensive
  --feedback-id <id>       配合 --feedback 指定餐品 id（默认取上次推荐）
  --view                   查看最近的记忆事件
  --view-type <type>       查看指定类型的事件
  --revoke <id>            撤销该餐品的反馈
  --confirm-dislike <id>   明确确认不喜欢（写入 confirmed，不被推断覆盖）
  --confirm-allergy <词>   明确确认过敏原（跨餐次生效）
  --confirm-ban <id>       明确全局忌口（任何餐次都排除）
  --unconfirm <id|词>      取消以上某条明确确认
  --export                 导出全部记忆为 JSON
  --clear                  清空记忆（同时清除由历史派生的偏好）
  --clear-keep-confirmed   清空事件但保留明确确认的忌口/过敏
  --purge                  清理超过保留期的事件（默认 180 天）

  ⚠️ 「明确确认」（confirmed）与「统计推断」是两回事：
      确认过的忌口不会被推断结果覆盖，推断也**不会**升级成禁忌。

环境变量：
  MCD_MCP_TOKEN            麦当劳 MCP Token（不填则用演示数据）
  MCD_MCP_URL              接入地址（默认 https://mcp.mcd.cn）
  MAIMEN_MEMORY_PATH       记忆文件路径（默认 ~/.maimen/memory.json）
  MAIMEN_RETENTION_DAYS    原始事件保留天数（默认 180）
  MAIMEN_WINDOW_DAYS       推荐读取窗口天数（默认 30）

示例：
  node run.mjs --budget 25 --slot lunch --drink hot --no-spicy
  node run.mjs --feedback like --feedback-id c
  node run.mjs --record consumed --record-id c
  node run.mjs --view --view-type feedback
  node run.mjs --confirm-allergy 花生 --confirm-ban 冰淇淋
  node run.mjs --unconfirm 冰淇淋`);
  process.exit(0);
}

if (args.zodiacs) {
  console.log(JSON.stringify(supportedZodiacs(), null, 2));
  process.exit(0);
}

// ── 记忆管理子命令（§7.2：查看 / 修改 / 撤销 / 导出 / 清空）──
// 这些命令只操作记忆，不做推荐，执行后即退出。
{
  const memPathOverride = process.env.MAIMEN_MEMORY_PATH;
  const retentionDays = Number(process.env.MAIMEN_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS;

  const recordType =
    args.record === true ? null : args.record ? String(args.record) : null;
  const feedbackVerdict =
    args.feedback === true ? null : args.feedback ? String(args.feedback) : null;
  const isMemoryCommand =
    recordType || feedbackVerdict || args.view || args.revoke || args.export || args.clear || args["clear-keep-confirmed"] || args.purge ||
    args["confirm-dislike"] || args["confirm-allergy"] || args["confirm-ban"] || args.unconfirm;

  if (isMemoryCommand) {
    const store = loadMemory();
    // 便捷取值：默认取最近一次 selected 的 mealId
    const lastSelected = () => {
      const list = listEvents(store, { type: EVENT_TYPES.RECOMMENDATION_SHOWN, limit: 1 });
      return list[0] || null;
    };
    const resolveMeal = (explicit) => {
      if (explicit) return { id: String(explicit), name: null };
      const last = lastSelected();
      if (!last) {
        console.error("未指定餐品 id，且没有可参考的上次推荐。请用 --record-id / --feedback-id 指定。");
        process.exit(2);
      }
      return { id: String(last.mealId), name: last.name };
    };

    const results = [];

    if (recordType) {
      const valid = [
        EVENT_TYPES.SELECTED,
        EVENT_TYPES.CONSUMED,
        EVENT_TYPES.REROLLED,
        EVENT_TYPES.SKIPPED,
      ];
      if (!valid.includes(recordType)) {
        fail(`--record 只接受 ${valid.join(" / ")}，收到 "${recordType}"`);
      }
      const meal = resolveMeal(args["record-id"]);
      // 同一动作重复执行不重复写入：用确定性 id + 当天 + 餐次
      const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
      const ev = makeEvent({
        type: recordType,
        eventId: deterministicId(recordType, meal.id, day, args.slot || ""),
        mealId: meal.id,
        name: meal.name,
        mealSlot: args.slot ? String(args.slot) : null,
        mealPurpose: args.purpose ? String(args.purpose) : null,
        sourceSnapshot: { source: "cli", status: "verified" },
      });
      const written = appendEvent(store, ev);
      saveMemory(store);
      results.push({ action: recordType, mealId: meal.id, written, path: memPathOverride || undefined });
    }

    if (feedbackVerdict) {
      if (!FEEDBACK_VERDICTS.includes(feedbackVerdict)) {
        fail(`--feedback 只接受 ${FEEDBACK_VERDICTS.join(" / ")}，收到 "${feedbackVerdict}"`);
      }
      const meal = resolveMeal(args["feedback-id"]);
      const ev = makeEvent({
        type: EVENT_TYPES.FEEDBACK,
        eventId: deterministicId("feedback", meal.id, feedbackVerdict, Date.now().toString()),
        mealId: meal.id,
        name: meal.name,
        verdict: feedbackVerdict,
        sourceSnapshot: { source: "user", status: "verified" },
      });
      appendEvent(store, ev);
      // dislike 同时进入用户明确确认偏好（不得被推断覆盖）
      if (feedbackVerdict === "dislike") {
        if (!store.confirmed.dislikes.includes(meal.id)) store.confirmed.dislikes.push(meal.id);
      }
      saveMemory(store);
      results.push({ action: "feedback", mealId: meal.id, verdict: feedbackVerdict });
    }

    if (args.revoke) {
      const n = revokeFeedback(store, String(args.revoke));
      saveMemory(store);
      results.push({ action: "revoke", mealId: String(args.revoke), removed: n });
    }

    // ── 明确确认偏好（preference_updated 事件，§7.2：不得被推断覆盖）──
    if (args["confirm-dislike"] || args["confirm-allergy"] || args["confirm-ban"] || args.unconfirm) {
      const take = (v) => (v === true || v == null ? null : String(v));
      const adding = {
        dislikes: take(args["confirm-dislike"]),
        allergies: take(args["confirm-allergy"]),
        globalBans: take(args["confirm-ban"]),
      };
      const removing = take(args.unconfirm);

      const next = {
        dislikes: [...(store.confirmed.dislikes || [])],
        allergies: [...(store.confirmed.allergies || [])],
        globalBans: [...(store.confirmed.globalBans || [])],
      };
      for (const [k, v] of Object.entries(adding)) {
        if (v && !next[k].includes(v)) next[k].push(v);
      }
      if (removing) {
        for (const k of Object.keys(next)) {
          next[k] = next[k].filter((x) => String(x) !== removing);
        }
      }
      updateConfirmed(store, next);
      saveMemory(store);
      results.push({
        action: "preference_updated",
        confirmed: next,
        added: Object.fromEntries(Object.entries(adding).filter(([, v]) => v)),
        removed: removing || undefined,
      });
    }

    if (args.view) {
      const type = args["view-type"] && args["view-type"] !== true ? String(args["view-type"]) : null;
      const slot = args.view === true ? null : args.view && String(args.view) !== "true" ? String(args.view) : null;
      const events = listEvents(store, { type, slot, limit: 50 });
      const payload = {
        memoryPath: memPathOverride || undefined,
        schemaVersion: store.schemaVersion,
        totalEvents: store.events.length,
        confirmed: store.confirmed,
        inferred: store.inferred,
        trend: trendReport(store, { slot }),
        events,
      };
      if (args.json) console.log(JSON.stringify(payload, null, 2));
      else {
        console.log(`📒 记忆（schema v${store.schemaVersion} · 共 ${store.events.length} 条事件）`);
        console.log("─".repeat(52));
        if (!events.length) console.log("（暂无匹配事件）");
        for (const e of events) {
          const extra = e.verdict ? ` [${e.verdict}]` : "";
          console.log(`  ${e.at.slice(0, 16).replace("T", " ")}  ${e.type}${extra}  ${e.name || e.mealId || ""}${e.mealSlot ? " · " + e.mealSlot : ""}`);
        }
        if (store.confirmed.dislikes.length) {
          console.log(`\n明确不喜欢（用户确认）：${store.confirmed.dislikes.join(", ")}`);
        }
        if (store.inferred.notes.length) {
          console.log(`推断偏好（仅供参考，非禁忌）：${store.inferred.notes.length} 条`);
        }
        console.log("─".repeat(52));
        console.log(payload.trend.note);
      }
      process.exit(0);
    }

    if (args.export) {
      const text = exportMemory(store);
      if (args.json) console.log(JSON.stringify({ exported: text }, null, 2));
      else console.log(text);
      process.exit(0);
    }

    if (args.purge) {
      const n = purgeExpired(store, { retentionDays });
      saveMemory(store);
      console.log(`已清理 ${n} 条超过 ${retentionDays} 天的事件（保留期可用 MAIMEN_RETENTION_DAYS 配置）。`);
      process.exit(0);
    }

    if (args.clear || args["clear-keep-confirmed"]) {
      clearMemory(store, { keepConfirmed: Boolean(args["clear-keep-confirmed"]) });
      saveMemory(store);
      console.log(
        args["clear-keep-confirmed"]
          ? "已清空事件与推断偏好，保留你明确确认的忌口/过敏。"
          : "已清空全部记忆（含由历史派生的偏好）。"
      );
      process.exit(0);
    }

    if (results.length && args.json) console.log(JSON.stringify(results, null, 2));
    else if (results.length) {
      for (const r of results) {
        if (r.action === "preference_updated") {
          const parts = [];
          if (r.added.dislikes) parts.push(`不喜欢 ${r.added.dislikes}`);
          if (r.added.allergies) parts.push(`过敏 ${r.added.allergies}`);
          if (r.added.globalBans) parts.push(`全局忌口 ${r.added.globalBans}`);
          if (r.removed) parts.push(`取消确认 ${r.removed}`);
          console.log(`✅ 已更新明确偏好：${parts.join("、") || "无变化"}`);
          console.log(`   不喜欢：${r.confirmed.dislikes.join(", ") || "（无）"}`);
          console.log(`   过敏原：${r.confirmed.allergies.join(", ") || "（无）"}`);
          console.log(`   全局忌口：${r.confirmed.globalBans.join(", ") || "（无）"}`);
          console.log("   这些是你明确确认的，不会被统计推断覆盖。");
        } else {
          console.log(`✅ ${r.action}：${r.mealId}${r.verdict ? " → " + r.verdict : ""}${r.written === false ? "（已存在，未重复写入）" : ""}`);
        }
      }
    }
    process.exit(0);
  }
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

  // ── 记忆（持久化读取，事件流模型）────────────────────
  const useMemory = !args["no-memory"];
  const memStore = useMemory ? loadMemory() : null;
  const windowDays = Number(process.env.MAIMEN_WINDOW_DAYS) || DEFAULT_WINDOW_DAYS;
  const memView = useMemory
    ? memoryForRecommend(memStore, { slot, windowDays })
    : { history: [], excluded: new Set(), lastPick: null, crossSlotPenalty: [], view: null };
  const { history, excluded, lastPick } = memView;

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
  let runResult = null;
  let comparisonScope = null;

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

      const live = await recommendLive({ menu, settings, storeCode: store.storeCode, history, previous: lastPick, preference, excluded });
      runResult = live.result;
      dataStatus = live.status;
      priceComparison = live.comparison;
      noSolutionReason = live.note;
      comparisonScope = live.scope;

    } catch (e) {
      // 区分「传输失败」与「业务失败」，不回退演示、不伪装成真实精算
      dataStatus = "failed";
      failureNote = `${e.kind === "transport" ? "服务不可达" : "调用失败"}：${e.message}`;
    }
  }

  if (!runResult) {
    runResult = recommend({
      settings,
      meals: dataStatus === "demo" ? meals : [],
      history,
      previous: lastPick,
      preference,
      excluded,
    });
    if (!runResult.meal && !noSolutionReason) noSolutionReason = runResult.emptyReason;
  }
  const finalMeal = runResult.meal;

  // ── 记录事件（§7.1：recommendation_shown 与 selected）────
  let writtenEvents = 0;
  if (useMemory && dataStatus !== "failed") {
    const day = new Date().toISOString().slice(0, 10);
    // 展示事件：用于本轮去重与推荐统计
    const shownIds = (runResult.meal ? [runResult.meal.id] : []).concat(
      history.filter((h) => h.kind === "selected").map((h) => h.id)
    );
    if (finalMeal) {
      if (
        appendEvent(
          memStore,
          makeEvent({
            type: EVENT_TYPES.RECOMMENDATION_SHOWN,
            eventId: deterministicId("shown", finalMeal.id, day, slot),
            mealId: finalMeal.id,
            name: finalMeal.name,
            mealSlot: slot,
            mealPurpose: purpose,
            priceCents: finalMeal.price,
            storeCode: store ? store.storeCode : null,
            sourceSnapshot: { source: priceComparison ? "mcp:calculate-price" : "static", status: priceComparison ? priceComparison.status : "demo" },
            note: `候选 ${runResult.count} 套`,
          })
        )
      )
        writtenEvents++;

    }
    purgeExpired(memStore, { retentionDays: Number(process.env.MAIMEN_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS });
    saveMemory(memStore);
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
    memory: { source: "本地记忆文件（事件流）", status: useMemory && history.length ? "verified" : "unknown", scope: `slot=${slot};window=${windowDays}d`, validFor: "事件保留 180 天（可配）" },
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
          priceStatus: dataStatus === "demo" ? "demo" : finalMeal.priceStatus,
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
      schemaVersion: useMemory && memStore ? memStore.schemaVersion : null,
      eventCount: history.length,
      lastPick,
      excludedCount: excluded.size,
      recentSameSlot: memView.view ? memView.view.recentSameSlot : [],
      crossSlotCount: memView.crossSlotPenalty.length,
      windowDays,
      wroteEvents: writtenEvents,
    },
    reminder: finalMeal
      ? { note: "本工具只询价、不创建订单、不付款；请自行前往麦当劳官方渠道下单。" }
      : null,
    warnings: [
      ...(comparisonScope ? [comparisonScope] : []),
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
    console.log(`   本次参考价：${money(finalMeal.price)}（符合条件共 ${runResult.count} 套）`);
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
