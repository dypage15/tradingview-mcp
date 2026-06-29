/**
 * @import test from 'node:test';
 * @import assert from 'node:assert';
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeMetrics,
  memoryTrendForChart,
  buildSuggestedActions,
} from '../scripts/lib/quant-advisor-core.mjs';

test('summarizeMetrics separates dollar DD from percent', () => {
  const m = {
    netProfit: 1000,
    maxStrategyDrawDown: 1500,
    maxStrategyDrawDownPercent: 2.5,
    profitFactor: 1.2,
    percentProfitable: 0.5,
    totalTrades: 40,
  };
  const s = summarizeMetrics(m);
  assert.equal(s.maxDrawdown, 1500);
  assert.equal(s.maxStrategyDrawDownPercent, 2.5);
  assert.ok(s.estimatedMaxDdUsd != null);
});

test('summarizeMetrics does not treat percent-only as dollar maxDrawdown', () => {
  const m = { netProfit: 1, maxStrategyDrawDownPercent: 3.0 };
  const s = summarizeMetrics(m);
  assert.equal(s.maxDrawdown, null);
  assert.ok(s.estimatedMaxDdUsd != null);
});

test('memoryTrendForChart computes direction', () => {
  const rows = [
    { chartKey: 'A|5', metricsSummary: { netProfit: 100 } },
    { chartKey: 'A|5', metricsSummary: { netProfit: 200 } },
    { chartKey: 'A|5', metricsSummary: { netProfit: 50 } },
  ];
  const t = memoryTrendForChart(rows, 'A|5', 10);
  assert.equal(t.direction, 'down');
  assert.equal(t.sampleSize, 3);
});

test('buildSuggestedActions includes grid when DD_CAP', () => {
  const pri = [{ level: 'high', code: 'DD_CAP', text: 'x' }];
  const a = buildSuggestedActions(pri);
  assert.ok(a.some((x) => x.kind === 'grid'));
});
