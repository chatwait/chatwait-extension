import { storage } from './storage';
import { sendEvents } from './api';

const FLUSH_INTERVAL_MS = 30 * 1000;
const FLUSH_BATCH_SIZE = 20;

let flushTimer: ReturnType<typeof setInterval> | null = null;

export function startEventFlusher() {
  if (flushTimer) return;
  flushTimer = setInterval(flushQueue, FLUSH_INTERVAL_MS);
}

export async function flushQueue() {
  const events = await storage.flushEventQueue();
  if (events.length === 0) return;

  // ad_ids resolved (billable or a recorded non-billable duplicate/cap/race) across every
  // batch that actually made it out this flush -- resolved against the local dedup lock
  // below regardless of which specific RECORD_EVENT call (if any) triggered this flush, since
  // the periodic flusher and RECORD_EVENT's own immediate flush both hit this same function.
  const recordedAdIds: string[] = [];

  // process in batches
  for (let i = 0; i < events.length; i += FLUSH_BATCH_SIZE) {
    const batch = events.slice(i, i + FLUSH_BATCH_SIZE);
    try {
      const { results } = await sendEvents(batch);
      recordedAdIds.push(...results);
    } catch {
      // re-enqueue failed batch for next flush
      for (const e of batch) await storage.enqueueEvent(e);
      break;
    }
  }

  if (recordedAdIds.length > 0) await storage.resolveRecordedAds(recordedAdIds);
}
