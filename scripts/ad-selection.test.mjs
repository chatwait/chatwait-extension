import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseAdByServeHistory, isServePoolExhausted } from '../lib/ad-selection.ts';

const ads = ['a', 'b', 'c'].map((id) => ({
  id,
  text: id,
  url: `https://example.com/${id}`,
  sponsor_name: id,
}));

test('prefers an unseen ad over previously served ads', () => {
  const selected = chooseAdByServeHistory(ads, {
    a: { lastServedAt: 300, serveCount: 2 },
    b: { lastServedAt: 200, serveCount: 1 },
  });
  assert.equal(selected?.id, 'c');
});

test('serves the highest-ranked ad in the unseen pool', () => {
  assert.equal(chooseAdByServeHistory(ads, {})?.id, 'a');
  const selected = chooseAdByServeHistory(ads, { a: { lastServedAt: 300, serveCount: 1 } });
  assert.equal(selected?.id, 'b');
});

test('rotates past a top-ranked ad while a lower-ranked one is still unseen', () => {
  const selected = chooseAdByServeHistory(ads, {
    a: { lastServedAt: 300, serveCount: 1 },
    b: { lastServedAt: 200, serveCount: 1 },
  });
  assert.equal(selected?.id, 'c');
});

test('uses the least-recently-served ad after inventory is exhausted', () => {
  const selected = chooseAdByServeHistory(ads, {
    a: { lastServedAt: 300, serveCount: 1 },
    b: { lastServedAt: 100, serveCount: 5 },
    c: { lastServedAt: 200, serveCount: 2 },
  });
  assert.equal(selected?.id, 'b');
});

test('breaks least-recently-served ties by server rank', () => {
  const selected = chooseAdByServeHistory(ads, {
    a: { lastServedAt: 300, serveCount: 1 },
    b: { lastServedAt: 100, serveCount: 5 },
    c: { lastServedAt: 100, serveCount: 2 },
  });
  assert.equal(selected?.id, 'b');
});

test('safely repeats when only one ad is available', () => {
  const selected = chooseAdByServeHistory([ads[0]], { a: { lastServedAt: 300, serveCount: 4 } });
  assert.equal(selected?.id, 'a');
});

test('returns null for empty inventory', () => {
  assert.equal(chooseAdByServeHistory([], {}), null);
});

test('recognizes exhaustion only after every selectable cached ad was used', () => {
  assert.equal(isServePoolExhausted(['a', 'b'], ads), false);
  assert.equal(isServePoolExhausted(['a', 'b', 'c'], ads), true);
});

test('does not treat empty inventory as an exhausted batch', () => {
  assert.equal(isServePoolExhausted([], []), false);
});
