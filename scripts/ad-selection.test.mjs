import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseAdByServeHistory, isServePoolExhausted } from '../lib/ad-selection.ts';

const ads = ['a', 'b', 'c'].map((id) => ({
  id,
  text: id,
  url: `https://example.com/${id}`,
  sponsor_name: id,
}));

// All existing entries below are well within the 30-minute serve-history TTL relative to this
// fixed `now`, so they exercise "recently seen" behavior unchanged by the TTL addition.
const now = 1_000;

test('prefers an unseen ad over previously served ads', () => {
  const selected = chooseAdByServeHistory(ads, {
    a: { lastServedAt: 300, serveCount: 2 },
    b: { lastServedAt: 200, serveCount: 1 },
  }, now);
  assert.equal(selected?.id, 'c');
});

test('serves the highest-ranked ad in the unseen pool', () => {
  assert.equal(chooseAdByServeHistory(ads, {}, now)?.id, 'a');
  const selected = chooseAdByServeHistory(ads, { a: { lastServedAt: 300, serveCount: 1 } }, now);
  assert.equal(selected?.id, 'b');
});

test('rotates past a top-ranked ad while a lower-ranked one is still unseen', () => {
  const selected = chooseAdByServeHistory(ads, {
    a: { lastServedAt: 300, serveCount: 1 },
    b: { lastServedAt: 200, serveCount: 1 },
  }, now);
  assert.equal(selected?.id, 'c');
});

test('uses the least-recently-served ad after inventory is exhausted', () => {
  const selected = chooseAdByServeHistory(ads, {
    a: { lastServedAt: 300, serveCount: 1 },
    b: { lastServedAt: 100, serveCount: 5 },
    c: { lastServedAt: 200, serveCount: 2 },
  }, now);
  assert.equal(selected?.id, 'b');
});

test('breaks least-recently-served ties by server rank', () => {
  const selected = chooseAdByServeHistory(ads, {
    a: { lastServedAt: 300, serveCount: 1 },
    b: { lastServedAt: 100, serveCount: 5 },
    c: { lastServedAt: 100, serveCount: 2 },
  }, now);
  assert.equal(selected?.id, 'b');
});

test('safely repeats when only one ad is available', () => {
  const selected = chooseAdByServeHistory([ads[0]], { a: { lastServedAt: 300, serveCount: 4 } }, now);
  assert.equal(selected?.id, 'a');
});

test('returns null for empty inventory', () => {
  assert.equal(chooseAdByServeHistory([], {}, now), null);
});

test('treats a served ad as unseen again once its history entry is older than the TTL', () => {
  const TTL = 30 * 60 * 1000;
  const servedAt = 10_000_000;
  // Exhausted 1ms before the 30-minute TTL: still "seen", falls to least-recently-served.
  const stillSeen = chooseAdByServeHistory(ads, {
    a: { lastServedAt: servedAt, serveCount: 1 },
    b: { lastServedAt: servedAt, serveCount: 1 },
    c: { lastServedAt: servedAt, serveCount: 1 },
  }, servedAt + TTL - 1);
  assert.equal(stillSeen?.id, 'a');

  // Exactly at the TTL boundary: expired, back in the unseen pool, highest rank wins.
  const expired = chooseAdByServeHistory(ads, {
    a: { lastServedAt: servedAt, serveCount: 1 },
    b: { lastServedAt: servedAt, serveCount: 1 },
    c: { lastServedAt: servedAt, serveCount: 1 },
  }, servedAt + TTL);
  assert.equal(expired?.id, 'a');
});

test('a lower-ranked unseen ad still wins over a higher-ranked ad whose TTL just expired', () => {
  // Both b and c are within TTL (recently served); only a's entry has expired, so a leads the
  // unseen pool by rank -- expiry restores it to the fast path rather than forcing a rotation
  // through b/c first.
  const TTL = 30 * 60 * 1000;
  const selected = chooseAdByServeHistory(ads, {
    a: { lastServedAt: 0, serveCount: 1 },
    b: { lastServedAt: TTL, serveCount: 1 },
    c: { lastServedAt: TTL, serveCount: 1 },
  }, TTL);
  assert.equal(selected?.id, 'a');
});

test('recognizes exhaustion only after every selectable cached ad was used', () => {
  assert.equal(isServePoolExhausted(['a', 'b'], ads), false);
  assert.equal(isServePoolExhausted(['a', 'b', 'c'], ads), true);
});

test('does not treat empty inventory as an exhausted batch', () => {
  assert.equal(isServePoolExhausted([], []), false);
});
