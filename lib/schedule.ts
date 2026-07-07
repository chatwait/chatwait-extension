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

  // process in batches
  for (let i = 0; i < events.length; i += FLUSH_BATCH_SIZE) {
    const batch = events.slice(i, i + FLUSH_BATCH_SIZE);
    try {
      await sendEvents(batch);
    } catch {
      // re-enqueue failed batch for next flush
      for (const e of batch) await storage.enqueueEvent(e);
      break;
    }
  }
}
