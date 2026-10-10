import assert from 'node:assert/strict';
import { recommend } from './recommend.mjs';
import { recommendLive } from './live-recommend.mjs';
import { normalizeMenu, buildCandidates, comparePrices } from './mcp.mjs';
import { yuanToCents } from '../../shared/money.mjs';
import { parseMcpText } from '../../shared/mcp-client.mjs';
import { scoreDay } from '../../maimen-calendar/scripts/campaign.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

for (const invalid of ['未知', '免费', 'abc12', ' ', -1, NaN, Infinity]) assert.equal(yuanToCents(invalid), null);
assert.equal(yuanToCents('￥19.90'), 1990);
assert.equal(recommend({ meals: [], settings: { budget: 40 } }).meal, null);
assert.throws(() => parseMcpText('data: {"error":{"code":1,"message":"denied"}}\n\n'), /denied/);
assert.throws(() => parseMcpText('{"result":{"isError":true,"content":[]}}'), /执行失败/);
assert.equal(parseMcpText('data: {"result":{"structuredContent":{"x":1}}}\n\ndata: {"method":"progress"}\n\n').x, 1);
assert.ok(!scoreDay({ date: '2026-10-10', events: [{ activityTitle: '10元早餐' }] }).reasons.join().includes('免单类'));

const settings = { budget: 30, drink: 'any', noSpicy: false, mealSlot: 'lunch', mealPurpose: 'full-meal' };
const menu = normalizeMenu({ meals: { a: { name: '鸡腿堡套餐', currentPrice: '20' }, b: { name: '牛肉堡套餐', currentPrice: '21' }, c: { name: '麦香鱼套餐', currentPrice: '22' } } });
let calls = 0;
const live = await recommendLive({ menu, settings, storeCode: 'test', calculate: async ({ items }) => { calls++; return { price: items[0].productCode === 'a' ? 3100 : items[0].productCode === 'b' ? 2400 : 3500 }; } });
assert.equal(calls, 3);
assert.equal(live.status, 'verified');
assert.equal(live.result.meal.id, 'b');
assert.equal(live.result.meal.price, 2400);
assert.equal(live.comparison.best.payableCents, 2400);
const failed = await recommendLive({ menu, settings, calculate: async () => { throw new Error('offline'); } });
assert.equal(failed.status, 'failed');
assert.equal(failed.result.meal, null);
const over = await recommendLive({ menu, settings, calculate: async () => ({ price: 4000 }) });
assert.equal(over.status, 'no-solution');
assert.equal(over.result.meal, null);
for (const price of [0, -1, NaN, Infinity, 1.2, '1000']) {
  assert.equal((await comparePrices([{ items: [] }], {}, async () => ({ price }))).status, 'failed');
}
const drinkMenu = normalizeMenu({ meals: { hot: { name: '热红茶', currentPrice: '10' }, cold: { name: '冰可乐', currentPrice: '8' }, main: { name: '麦香鸡堡', currentPrice: '12' } } });
const drinks = buildCandidates(drinkMenu, 3000, { purpose: 'drink-only', drink: 'hot' });
assert.equal(drinks.length, 1);
assert.equal(drinks[0].code, 'hot');
const drinkResult = await recommendLive({ menu: drinkMenu, settings: { ...settings, mealPurpose: 'drink-only', drink: 'hot' }, calculate: async () => ({ price: 1000 }) });
assert.equal(drinkResult.result.meal.id, 'hot');
assert.equal(recommend({ meals: [{ id:'unknown', main:'堡', price:1000, temp:'any' }], settings: { ...settings, drink:'hot' } }).meal, null);

// Exercise the actual CLI, including persistence, with an isolated mock transport.
const dir = mkdtempSync(join(tmpdir(), 'maimen-integration-'));
try {
  const preload = join(dir, 'mock.mjs');
  writeFileSync(preload, `globalThis.fetch = async (_url, opts) => {
    if (process.env.MAIMEN_TEST_FAILURE === '1') throw new Error('offline');
    const {params} = JSON.parse(opts.body);
    const data = params.name === 'query-meals' ? ${JSON.stringify({ meals: { a: { name: '鸡腿堡套餐', currentPrice: '20' } } })} : {price: 2500};
    return new Response(JSON.stringify({result:{structuredContent:{success:true,data}}}));
  };`);
  const memory = join(dir, 'memory.json');
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, fileURLToPath(new URL('./run.mjs', import.meta.url)), '--store', 'test', '--slot', 'lunch', '--budget', '30', '--json'], { encoding:'utf8', env: { ...process.env, MCD_MCP_TOKEN: 'test-only', MAIMEN_MEMORY_PATH: memory } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.dataStatus, 'verified');
  assert.equal(output.recommendation.priceCents, 2500);
  const records = JSON.parse(readFileSync(memory, 'utf8')).events;
  assert.equal(records.length, 1);
  assert.equal(records[0].type, 'recommendation_shown');
  const failedCli = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, fileURLToPath(new URL('./run.mjs', import.meta.url)), '--store', 'test', '--slot', 'lunch', '--budget', '30', '--json'], { encoding:'utf8', env: { ...process.env, MCD_MCP_TOKEN: 'test-only', MAIMEN_MEMORY_PATH: memory, MAIMEN_TEST_FAILURE: '1' } });
  assert.equal(failedCli.status, 0, failedCli.stderr);
  const failedOutput = JSON.parse(failedCli.stdout);
  assert.equal(failedOutput.dataStatus, 'failed');
  assert.equal(failedOutput.recommendation, null);
  assert.equal(JSON.parse(readFileSync(memory, 'utf8')).events.length, 1);
} finally {
  if (!resolve(dir).startsWith(resolve(tmpdir()) + '\\') && !resolve(dir).startsWith(resolve(tmpdir()) + '/')) throw new Error('Unexpected temp path');
  rmSync(dir, { recursive:true, force:true });
}
console.log('PASS: live pricing, strict constraints, empty/failure isolation, MCP errors, currency parsing, calendar scoring, CLI persistence');
