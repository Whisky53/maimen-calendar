#!/usr/bin/env node
/**
 * 真实 MCP 端到端联调：门店 → 菜单 → 组装候选 → 真实比价 → 挑最省。
 *
 * 用法：MCD_MCP_TOKEN=xxx node verify-mcp.mjs --city 上海 --budget 30
 *
 * 该脚本只读！不创建订单、不领券、不下单。
 */
import { hasMcp, mcd, normalizeMenu, splitMenu, comparePrices } from "./mcp.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) { out[k] = v; i++; } else out[k] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const city = args.city || "上海";
const budgetYuan = args.budget ? Number(args.budget) : 30;

const line = (n = 60) => "─".repeat(n);

async function main() {
  if (!hasMcp()) {
    console.error("❌ 未检测到 MCD_MCP_TOKEN，无法联调。");
    process.exit(2);
  }

  console.log(line());
  console.log("① 查门店  query-nearby-stores");
  console.log(line());
  const stores = await mcd.nearbyStores({ city, searchType: 1 });
  const store = Array.isArray(stores) ? stores[0] : null;
  if (!store) throw new Error("未取到门店");
  console.log(`  门店：${store.storeName}`);
  console.log(`  地址：${store.address}`);
  console.log(`  storeCode：${store.storeCode}`);
  console.log(`  beCode：${store.beCode ?? "（无）"}`);
  console.log(`  支持预约：${store.reservation}`);

  const storeCode = store.storeCode;

  console.log();
  console.log(line());
  console.log("② 查真实菜单  query-meals");
  console.log(line());
  const rawMenu = await mcd.meals({ storeCode });
  const menu = normalizeMenu(rawMenu);
  console.log(`  真实餐品数：${menu.length}`);
  const { mains, drinks, sides } = splitMenu(menu);
  console.log(`  主食 ${mains.length} / 饮品 ${drinks.length} / 小食 ${sides.length}`);

  console.log();
  console.log(line());
  console.log("③ 组装 3 套候选套餐（同价位段不同搭配）");
  console.log(line());
  // 在预算内挑主食 + 饮品，组装不同组合
  const budgetCents = budgetYuan * 100;
  const mainsInBudget = mains.filter((m) => m.price <= budgetCents).sort((a, b) => b.price - a.price);
  const drinksInBudget = drinks.filter((d) => d.price <= budgetCents).sort((a, b) => b.price - a.price);
  if (!mainsInBudget.length || !drinksInBudget.length) {
    throw new Error(`预算 ¥${budgetYuan} 内找不到主食或饮品，试试放宽预算`);
  }

  const candidates = [];
  // 候选1：最贵主食 + 最便宜饮品（钱花在主食上）
  candidates.push({
    label: "A · 主打主食（最贵主食+基础饮品）",
    items: [
      { productCode: mainsInBudget[0].code, quantity: 1 },
      { productCode: drinksInBudget[drinksInBudget.length - 1].code, quantity: 1 },
    ],
    detail: [mainsInBudget[0], drinksInBudget[drinksInBudget.length - 1]],
  });
  // 候选2：中等主食 + 中等饮品
  const midMain = mainsInBudget[Math.floor(mainsInBudget.length / 2)];
  const midDrink = drinksInBudget[Math.floor(drinksInBudget.length / 2)];
  candidates.push({
    label: "B · 均衡搭配（中档主食+中档饮品）",
    items: [
      { productCode: midMain.code, quantity: 1 },
      { productCode: midDrink.code, quantity: 1 },
    ],
    detail: [midMain, midDrink],
  });
  // 候选3：便宜主食 + 贵饮品 + 小食
  const cheapMain = mainsInBudget[mainsInBudget.length - 1];
  const sideInBudget = sides.filter((s) => s.price <= budgetCents).sort((a, b) => a.price - b.price)[0];
  const c3items = [
    { productCode: cheapMain.code, quantity: 1 },
    { productCode: drinksInBudget[0].code, quantity: 1 },
  ];
  const c3detail = [cheapMain, drinksInBudget[0]];
  if (sideInBudget) { c3items.push({ productCode: sideInBudget.code, quantity: 1 }); c3detail.push(sideInBudget); }
  candidates.push({ label: "C · 全都要（性价比主食+升级饮品+小食）", items: c3items, detail: c3detail });

  for (const c of candidates) {
    console.log(`  ${c.label}`);
    console.log(`    ${c.detail.map((d) => `${d.name} ¥${(d.price / 100).toFixed(2)}`).join(" + ")}`);
  }

  console.log();
  console.log(line());
  console.log("④ 真实比价  calculate-price（服务端精算，单位：分）");
  console.log(line());
  const cmp = await comparePrices(
    candidates.map((c) => ({ label: c.label, items: c.items, detail: c.detail })),
    { storeCode }
  );

  for (const r of cmp.all) {
    if (r.error) { console.log(`  ✗ ${r.label} → 失败：${r.error}`); continue; }
    const q = r.quote;
    const yuan = (q.price / 100).toFixed(2);
    const orig = (q.originalPrice / 100).toFixed(2);
    const disc = (q.discount / 100).toFixed(2);
    const flag = r === cmp.best ? "  ⭐ 最低" : "";
    console.log(`  ${r.label}`);
    console.log(`    现价 ¥${yuan}（原价 ¥${orig}，优惠 ¥${disc}）${flag}`);
    const names = (q.productList || []).map((p) => `${p.productName}×${p.quantity}`).join(" + ");
    console.log(`    明细：${names}`);
    console.log(`    取餐方式可选：${(q.takeWayList || []).map((t) => t.title).join(" / ") || "-"}`);
  }

  console.log();
  console.log(line());
  console.log("⑤ 结论");
  console.log(line());
  if (cmp.best) {
    console.log(`  🏆 最省方案：${cmp.best.label}`);
    console.log(`     应付 ¥${(cmp.best.payableCents / 100).toFixed(2)}`);
  }
  console.log("  说明：本脚本仅询价，不创建订单、不支付。");

  // 结构化输出，便于机器读取
  const summary = {
    ok: true,
    store: { storeCode, storeName: store.storeName, address: store.address },
    menuCount: menu.length,
    best: cmp.best
      ? { label: cmp.best.label, payableYuan: (cmp.best.payableCents / 100).toFixed(2) }
      : null,
    all: cmp.all.map((r) => ({
      label: r.label,
      payableYuan: r.payableCents != null ? (r.payableCents / 100).toFixed(2) : null,
      error: r.error || null,
    })),
  };
  console.log();
  console.log("JSON=" + JSON.stringify(summary));
}

main().catch((e) => {
  console.error("\n❌ 联调失败：" + e.message);
  process.exit(1);
});
