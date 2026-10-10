import { recommend } from './recommend.mjs';
import { buildCandidates, itemsForCandidate, comparePrices } from './mcp.mjs';

/** Reusable live pipeline. A failed quote never becomes a demo or menu-price recommendation. */
export async function recommendLive({ menu, settings, storeCode, history = [], previous, preference, excluded, calculate }) {
  const context = { settings, history, previous, preference, excluded };
  const toMeal = (c) => ({ ...c, id: c.code, main: c.main ? c.name : '',
    hasMain: Boolean(c.main || c.isCombo), hasDrink: Boolean(c.drink), drinkOnly: Boolean(c.drinkOnly) });
  const candidates = buildCandidates(menu, Math.round(settings.budget * 100), { purpose: settings.mealPurpose, drink: settings.drink });
  const eligible = candidates.filter((c) => recommend({ ...context, meals: [toMeal(c)] }).meal);
  // Bound latency and make the comparison scope explicit. This is not a global lowest-price claim.
  const shortlist = eligible.sort((a, b) => a.price - b.price).slice(0, 6);
  const comparison = await comparePrices(shortlist.map((c) => ({ label: c.name, items: itemsForCandidate(c), detail: c })), { storeCode }, calculate);
  const verified = comparison.all.filter((q) => q.status === 'verified').map((q) => ({ ...toMeal(q.detail), price: q.payableCents, priceStatus: 'verified' }));
  const result = recommend({ ...context, meals: verified });
  const withinBudget = verified.filter((m) => recommend({ ...context, meals: [m] }).meal);
  const status = !shortlist.length ? 'no-solution' : !verified.length ? 'failed' : result.meal ? 'verified' : 'no-solution';
  return { result, status, comparison: { ...comparison, best: comparison.all.filter((q) => withinBudget.some((m) => m.id === q.detail.code)).sort((a,b) => a.payableCents - b.payableCents)[0] || null },
    note: status === 'failed' ? '候选核价均未成功，请稍后重试' : !result.meal ? '当前条件下没有已核价且预算内的候选' : null,
    scope: `菜单初筛 ${eligible.length} 套，核价 ${shortlist.length} 套；最低价仅指本次已核价且符合约束的候选，不保证全局最低` };
}
