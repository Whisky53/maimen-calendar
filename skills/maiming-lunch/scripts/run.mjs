#!/usr/bin/env node
/**
 * 麦命打工人 · 午间补给站 —— Skill 主入口
 *
 * 用法：
 *   node run.mjs --budget 30 --drink hot --no-spicy --city 上海 --birthday 2000-08-15
 *   node run.mjs --budget 25 --weather '{"tempC":5,"precipitation":"rain"}' --json
 *   node run.mjs --demo --budget 20          # 强制演示数据
 *   node run.mjs --store 1400685 --budget 40 # 指定真实门店
 *
 * 有 MCD_MCP_TOKEN 时走真实 MCP：查门店 → 查真实菜单 → 硬约束筛选 → 真实比价。
 * 否则自动回退内置演示数据，保证离线可跑。
 */
import { recommend, DEMO_MEALS, DEFAULT_SETTINGS } from "./recommend.mjs";
import { derivePreferences, supportedZodiacs } from "./preference.mjs";
import {
  hasMcp,
  mcd,
  normalizeMenu,
  buildCandidates,
  itemsForCandidate,
  comparePrices,
} from "./mcp.mjs";

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
  console.log(`麦命打工人 · 午间补给站 Skill

参数：
  --budget <元>            午餐预算上限（默认 30）
  --drink <any|hot|cold>   冷热饮偏好（默认 any）
  --no-spicy               不吃辣
  --city <城市>            常用城市（默认 上海）
  --birthday <YYYY-MM-DD>  生日，用于星座偏好映射
  --weather <json|"温,降水"> 今日天气，如 {"tempC":5,"precipitation":"rain"}
  --store <门店ID>         指定真实门店 storeCode（跳过门店查询）
  --json                   以 JSON 输出
  --demo                   强制使用演示数据（即使有 Token）
  --zodiacs                列出支持的星座

环境变量：
  MCD_MCP_TOKEN            麦当劳 MCP Token（不填则用演示数据）
  MCD_MCP_URL              接入地址（默认 https://mcp.mcd.cn）

示例：
  node run.mjs --budget 25 --drink hot --no-spicy --birthday 2000-08-15
  node run.mjs --weather '{"tempC":5,"precipitation":"rain"}' --json`);
  process.exit(0);
}

if (args.zodiacs) {
  console.log(JSON.stringify(supportedZodiacs(), null, 2));
  process.exit(0);
}

const money = (cents) => `¥${(cents / 100).toFixed(2)}`;

async function main() {
  const settings = {
    ...DEFAULT_SETTINGS,
    budget: args.budget ? Number(args.budget) : DEFAULT_SETTINGS.budget,
    drink: ["any", "hot", "cold"].includes(args.drink) ? args.drink : "any",
    noSpicy: Boolean(args["no-spicy"]),
    city: args.city || DEFAULT_SETTINGS.city,
  };
  const weather = parseWeather(args.weather);
  const birthday = args.birthday || null;
  const preference = derivePreferences({ weather, birthday, explicitDrink: settings.drink });
  const budgetCents = Math.round(settings.budget * 100);

  // ---- 数据源：真实 MCP 优先 ----
  let source = "demo";
  let store = null;
  let meals = DEMO_MEALS;
  let priceComparison = null;
  let finalMeal = null;

  if (hasMcp() && !args.demo) {
    try {
      // ① 门店
      if (args.store) {
        store = { storeCode: String(args.store), storeName: "指定门店" };
      } else {
        const stores = await mcd.nearbyStores({ city: settings.city, searchType: 1 });
        store = Array.isArray(stores) ? stores[0] : null;
      }
      if (!store || !store.storeCode) throw new Error("未取到门店");

      // ② 真实菜单
      const rawMenu = await mcd.meals({ storeCode: store.storeCode });
      const menu = normalizeMenu(rawMenu);
      if (!menu.length) throw new Error("菜单为空");

      // ③ 生成候选（官方套餐优先）
      const candidates = buildCandidates(menu, budgetCents);
      if (!candidates.length) throw new Error(`预算 ${money(budgetCents)} 内无候选套餐`);

      // ④ 硬约束 + 软偏好筛选（复用推荐引擎的约束语义）
      const pre = recommend({
        settings,
        meals: candidates.map((c) => ({
          id: c.code,
          name: c.name,
          main: c.name,
          side: c.category,
          drink: "",
          temp: c.temp || "any",
          price: c.price,
          spicy: c.spicy,
        })),
        history: [],
        preference,
      });

      // ⑤ 在筛选后的候选里做真实比价（比价只用于「同类候选间找更省」，不改变推荐单元）
      const shortlist = candidates
        .filter((c) => c.price <= budgetCents)
        .filter((c) => !(settings.noSpicy && c.spicy))
        .slice(0, 8)
        .map((c) => ({
          label: c.name,
          items: itemsForCandidate(c),
          detail: c,
        }));

      if (shortlist.length) {
        const cmp = await comparePrices(shortlist, { storeCode: store.storeCode });
        priceComparison = cmp;
      }
      meals = candidates;
      source = "mcp";
      // 推荐单元由推荐引擎决定（满足预算/冷热/忌口/星座偏好），而非单纯最便宜
      finalMeal = pre.meal;
    } catch (e) {
      source = `demo（MCP 不可用：${e.message}）`;
    }
  }

  const result = recommend({ settings, meals, history: [], preference });
  if (!finalMeal) finalMeal = result.meal;

  // 把真实比价结论融进理由
  const extraReasons = [];
  if (priceComparison && finalMeal) {
    const mine = priceComparison.all.find((r) => r.label === finalMeal.name);
    if (mine && typeof mine.payableCents === "number") {
      extraReasons.push(`服务端实付精算 ${money(mine.payableCents)}`);
      const cheaper = priceComparison.all.filter(
        (r) => typeof r.payableCents === "number" && r.payableCents < mine.payableCents
      );
      if (!cheaper.length) extraReasons.push("在候选方案里已是实付最低的一档");
      else extraReasons.push(`同场更低价有 ${cheaper.length} 档（可加 --budget 放宽或换口味）`);
    }
  }

  const payload = {
    source,
    store: store ? { storeCode: store.storeCode, storeName: store.storeName } : null,
    settings,
    preference: { preferredTemp: preference.preferredTemp, signals: preference.signals },
    recommendation: finalMeal
      ? {
          name: finalMeal.name,
          price: finalMeal.price != null ? money(finalMeal.price) : null,
          category: finalMeal.category || finalMeal.side || "",
          temp: finalMeal.temp || "any",
        }
      : null,
    reasons: result.reasons,
    eligibleCount: result.count,
    priceComparison: priceComparison
      ? {
          best: priceComparison.best
            ? {
                label: priceComparison.best.label,
                payable: money(priceComparison.best.payableCents),
              }
            : null,
          all: priceComparison.all.map((r) => ({
            label: r.label,
            payable: r.payableCents != null ? money(r.payableCents) : null,
            error: r.error || null,
          })),
        }
      : null,
    note: "价格来自麦当劳 MCP 服务端精算；本工具只询价，不创建订单、不付款。",
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("🍟 麦命打工人 · 今日午饭建议");
  console.log("─".repeat(44));
  console.log(`数据来源：${source}`);
  if (store) console.log(`门店：${store.storeName}（${store.storeCode}）`);
  console.log(
    `预算结界：${money(budgetCents)} · 冷热：${settings.drink} · ${settings.noSpicy ? "不吃辣" : "不限辣"}`
  );
  if (preference.signals.length) {
    console.log("偏好信号：");
    for (const s of preference.signals) console.log(`  · ${s.reason}`);
  }
  if (preference.conflict) console.log(`⚠️  ${preference.conflict}`);
  console.log("─".repeat(44));

  if (priceComparison && priceComparison.all.length) {
    console.log("💱 真实比价（服务端精算）：");
    for (const r of priceComparison.all) {
      if (r.error) {
        console.log(`   ✗ ${r.label} → ${r.error}`);
        continue;
      }
      const star = priceComparison.best && r.label === priceComparison.best.label ? " ⭐最省" : "";
      console.log(`   ${r.label}：${money(r.payableCents)}${star}`);
    }
    console.log("─".repeat(44));
  }

  if (!finalMeal) {
    console.log("⚠️  当前条件下没有可行方案，试试放宽预算或调整偏好。");
  } else {
    console.log(`👉 ${finalMeal.name}`);
    if (finalMeal.category) console.log(`   分类：${finalMeal.category}`);
    console.log(`   标价：${money(finalMeal.price)}（符合条件共 ${result.count} 套）`);
    console.log("   理由：");
    for (const r of result.reasons) console.log(`     · ${r}`);
    for (const r of extraReasons) console.log(`     · ${r}`);
  }
  console.log("─".repeat(44));
  console.log("非官方应用 · 只询价不下单不付款 · 价格以麦当劳官方渠道为准");
}

main().catch((e) => {
  console.error("运行失败：", e.message);
  process.exit(1);
});
