const MIN_DWELL_MS = 5000;
const MAX_PER_DAY = 60;
const MIN_INTERVAL_MS = 60 * 1000;
const DAY_COUNT_KEY = 'chatwait_imp_day';
const DAY_TS_KEY = 'chatwait_imp_day_ts';
const LAST_IMP_KEY = 'chatwait_imp_last';

export class ImpressionTracker {
  private startTs = 0;
  private visibleMs = 0;
  private lastVisibleStart = 0;
  private qualified = false;
  private impressionId = '';
  private onQualifiedCb: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private focusHandler: (() => void) | null = null;
  private blurHandler: (() => void) | null = null;

  start(adId: string, onQualified: () => void) {
    this.stop();
    if (!this.canShow()) return;

    this.startTs = Date.now();
    this.visibleMs = 0;
    this.qualified = false;
    // Generated up front (not read back from the server) so a click that happens before the
    // impression qualifies, or before the batched event flush completes, can still reference
    // the same id the impression row will end up with.
    this.impressionId = crypto.randomUUID();
    this.onQualifiedCb = onQualified;

    if (document.visibilityState === 'visible' && document.hasFocus()) {
      this.lastVisibleStart = Date.now();
    }

    this.visibilityHandler = () => this.onVisibilityChange();
    this.focusHandler = () => this.onFocusChange(true);
    this.blurHandler = () => this.onFocusChange(false);

    document.addEventListener('visibilitychange', this.visibilityHandler);
    window.addEventListener('focus', this.focusHandler);
    window.addEventListener('blur', this.blurHandler);

    this.scheduleCheck();
  }

  stop() {
    this.flush();
    if (this.timer) clearTimeout(this.timer);
    if (this.visibilityHandler) document.removeEventListener('visibilitychange', this.visibilityHandler);
    if (this.focusHandler) window.removeEventListener('focus', this.focusHandler);
    if (this.blurHandler) window.removeEventListener('blur', this.blurHandler);
    this.timer = null;
    this.onQualifiedCb = null;
  }

  dwellMs(): number {
    return this.visibleMs + (this.lastVisibleStart ? Date.now() - this.lastVisibleStart : 0);
  }

  /** Id of the in-flight impression, or '' if none is being tracked. Only meaningful for
   * linking a click to its impression once `isQualified()` is true — the row doesn't exist
   * server-side (and the FK would reject it) until the impression has qualified. */
  getImpressionId(): string {
    return this.impressionId;
  }

  isQualified(): boolean {
    return this.qualified;
  }

  private scheduleCheck() {
    this.timer = setTimeout(() => {
      if (!this.qualified && this.dwellMs() >= MIN_DWELL_MS) {
        this.qualified = true;
        this.recordImpression();
        this.onQualifiedCb?.();
      }
    }, MIN_DWELL_MS);
  }

  private flush() {
    if (this.lastVisibleStart) {
      this.visibleMs += Date.now() - this.lastVisibleStart;
      this.lastVisibleStart = 0;
    }
  }

  private onVisibilityChange() {
    if (document.visibilityState === 'visible') {
      this.lastVisibleStart = Date.now();
    } else {
      this.flush();
    }
  }

  private onFocusChange(focused: boolean) {
    if (focused) {
      this.lastVisibleStart = Date.now();
    } else {
      this.flush();
    }
  }

  private canShow(): boolean {
    const now = Date.now();
    const dayStart = startOfDay(now);
    const storedDayTs = Number(localStorage.getItem(DAY_TS_KEY) ?? 0);
    const count = storedDayTs === dayStart ? Number(localStorage.getItem(DAY_COUNT_KEY) ?? 0) : 0;
    if (count >= MAX_PER_DAY) return false;

    const lastImp = Number(localStorage.getItem(LAST_IMP_KEY) ?? 0);
    if (now - lastImp < MIN_INTERVAL_MS) return false;

    return true;
  }

  private recordImpression() {
    const now = Date.now();
    const dayStart = startOfDay(now);
    const storedDayTs = Number(localStorage.getItem(DAY_TS_KEY) ?? 0);
    const count = storedDayTs === dayStart ? Number(localStorage.getItem(DAY_COUNT_KEY) ?? 0) : 0;
    localStorage.setItem(DAY_TS_KEY, String(dayStart));
    localStorage.setItem(DAY_COUNT_KEY, String(count + 1));
    localStorage.setItem(LAST_IMP_KEY, String(now));
  }
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
