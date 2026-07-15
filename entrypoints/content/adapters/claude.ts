import type { PromptAdapter, PromptCallbacks } from './types';

// Verified 2026-06-12 against live claude.ai; USER_BUBBLE re-verified 2026-07-02
const SEND_BTN = 'button[aria-label="Send message"]';
const COMPOSER  = '[data-testid="chat-input"]';
export const USER_MSG  = '[data-testid="user-message"]';
// [data-testid="user-message"] lives inside the message bubble (the div with
// data-user-message-bubble, which carries the rounded gray background). Anchoring the card
// there via afterEl.after() inserted it as a sibling *inside* that bubble's parent chain, so
// it rendered nested inside the bubble's own background instead of in the dead space below
// it. USER_BUBBLE's own parentElement is the full-width row wrapper the bubble is centered
// in — anchoring there instead escapes the bubble.
const USER_BUBBLE = '[data-user-message-bubble]';

/** Given a matched USER_MSG element, returns the element the ad card should be anchored
 * after — the bubble's parent, escaping its rounded background. Exported so any other
 * caller anchoring off USER_MSG (e.g. the WXT_PREVIEW dev script) applies the same fix
 * instead of re-deriving (and potentially re-breaking) it. */
export function resolveAnchor(userMsgEl: HTMLElement): HTMLElement {
  const bubble = userMsgEl.closest<HTMLElement>(USER_BUBBLE);
  return bubble?.parentElement ?? userMsgEl;
}

function lastOf(list: NodeListOf<HTMLElement>): HTMLElement | null {
  return list.length ? list[list.length - 1] : null;
}

// How close (either side) a submit signal and a first-message mutation must land to be treated
// as the same submission. The two fire within the same event turn on a real submit (Claude
// renders the user message optimistically), so 1s is generous; anything further apart is a
// history load with an unrelated submit signal nearby.
const SUBMIT_CORROBORATION_MS = 1000;

export class ClaudeAdapter implements PromptAdapter {
  host = 'claude.ai';

  private cb: PromptCallbacks | null = null;
  private sendHandler: (() => void) | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private boundBtn: HTMLElement | null = null;
  private boundComposer: HTMLElement | null = null;
  private trackingObserver: MutationObserver | null = null;
  private doneObserver: MutationObserver | null = null;
  private reattachObserver: MutationObserver | null = null;

  // The trailing user message we've already anchored an ad to (or whatever was already there
  // when the adapter started, so pre-existing history never fires on its own). Compared
  // continuously by trackingObserver instead of gating on a flag armed by the submit handler —
  // confirmed live (diagnostic logging) that the new message can already be in the DOM *before*
  // our own click/keydown handler even runs (Tiptap's own Enter handling sits on the same
  // composer node our listener is on, and same-node listeners fire in registration order, not
  // capture-before-bubble; a duplicate/delayed synthetic keydown had the same effect in testing).
  // There is no reliable "before submit" moment left to snapshot from, so instead: whichever
  // fires first, submit or the mutation, the first callback to see the trailing message differ
  // from what's already anchored is the one that anchors it. onSubmit() only drives the
  // diagnostic 12s watchdog now, not the detection logic itself.
  private lastAnchoredMsg: HTMLElement | null = null;
  private lastAnchoredText: string | null = null;

  // On a full page load, `start()` can run before Claude has finished streaming in the
  // thread's history, so the trailing message keeps changing for a while with no real
  // submission involved. Same thing happens right after a sidebar navigation swaps in a
  // different thread: its history then loads in incrementally. In both cases each new
  // history message looks identical to a genuine append (prior message still in the DOM),
  // so trailing-message diffing alone can't tell them apart. `settling` suppresses anchoring
  // during those loads; it's held open (via settleTimer) as long as the trailing message
  // keeps changing, and only clears once things go quiet, so slow loads are covered too.
  private settling = true;
  private settleTimer: number | null = null;

  // Wall-clock of the most recent send-button click / Enter keydown. A trailing message
  // appearing where the adapter has never seen one (lastAnchoredMsg still null) is ambiguous:
  // it's either the first prompt of a brand-new chat, or history loading after a sidebar nav
  // from a message-less page (home / new chat) — and the unmounted-prior swap check below
  // can't catch that nav, because there was no prior element to observe unmounting. Only a
  // submit signal tells the two apart, so that case requires one within
  // SUBMIT_CORROBORATION_MS. Since the submit handler can also run *after* the mutation (see
  // the lastAnchoredMsg comment), the uncorroborated element is parked in pendingFirstMsg for
  // handleSubmit to anchor if the signal arrives late.
  private lastSubmitAt = 0;
  private pendingFirstMsg: HTMLElement | null = null;
  private pendingFirstMsgAt = 0;

  start(cb: PromptCallbacks) {
    this.cb = cb;
    this.attach();
    this.reattachObserver = new MutationObserver(() => this.attach());
    this.reattachObserver.observe(document.body, { childList: true, subtree: true });

    const initial = lastOf(document.querySelectorAll<HTMLElement>(USER_MSG));
    this.lastAnchoredMsg = initial;
    this.lastAnchoredText = initial?.textContent ?? null;
    this.settling = true;
    this.armSettle();
    this.trackingObserver = new MutationObserver(() => this.handleMutation());
    // characterData is needed alongside childList: a virtualized/recycled list can update an
    // existing node's text in place instead of inserting a fresh node.
    this.trackingObserver.observe(document.body, { childList: true, characterData: true, subtree: true });
  }

  stop() {
    this.detach();
    this.reattachObserver?.disconnect();
    this.trackingObserver?.disconnect();
    this.doneObserver?.disconnect();
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.reattachObserver = null;
    this.trackingObserver = null;
    this.doneObserver = null;
    this.settleTimer = null;
    this.pendingFirstMsg = null;
  }

  private armSettle() {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      this.settling = false;
      this.settleTimer = null;
    }, 700);
  }

  hostAdVisible(): boolean {
    return false; // Anthropic does not run ads on claude.ai
  }

  private attach() {
    const btn = document.querySelector<HTMLElement>(SEND_BTN);
    const composer = document.querySelector<HTMLElement>(COMPOSER);
    if (!btn || !composer) return;
    // Re-bind whenever the live node differs from the one we're attached to, instead of a
    // one-shot bind gated on `sendHandler` truthiness (see chatgpt.ts for why that goes stale).
    if (btn === this.boundBtn && composer === this.boundComposer) return;
    this.detach();

    this.boundBtn = btn;
    this.boundComposer = composer;
    this.sendHandler = () => this.handleSubmit();
    btn.addEventListener('click', this.sendHandler, true);

    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) this.handleSubmit();
    };
    composer.addEventListener('keydown', this.keyHandler, true);
  }

  private detach() {
    if (this.sendHandler && this.boundBtn) this.boundBtn.removeEventListener('click', this.sendHandler, true);
    if (this.keyHandler && this.boundComposer) this.boundComposer.removeEventListener('keydown', this.keyHandler, true);
    this.sendHandler = null;
    this.keyHandler = null;
    this.boundBtn = null;
    this.boundComposer = null;
  }

  private handleSubmit() {
    this.lastSubmitAt = Date.now();
    this.cb?.onSubmit();
    // If a fresh thread's first message hit the DOM before this handler ran, handleMutation
    // parked it (no corroborating submit yet); anchor it now that the submit is confirmed.
    const pending = this.pendingFirstMsg;
    this.pendingFirstMsg = null;
    if (
      pending &&
      Date.now() - this.pendingFirstMsgAt < SUBMIT_CORROBORATION_MS &&
      pending === lastOf(document.querySelectorAll<HTMLElement>(USER_MSG))
    ) {
      this.cb?.onAnchorReady(resolveAnchor(pending));
      this.watchForDone();
    }
  }

  private handleMutation() {
    const newEl = lastOf(document.querySelectorAll<HTMLElement>(USER_MSG));
    if (!newEl) return;
    const isNew = newEl !== this.lastAnchoredMsg || newEl.textContent !== this.lastAnchoredText;

    if (this.settling) {
      // Still loading history in (page load or a just-swapped-in thread from sidebar nav) —
      // rebaseline silently and keep the settle window open as long as it keeps changing.
      if (isNew) {
        this.lastAnchoredMsg = newEl;
        this.lastAnchoredText = newEl.textContent;
        this.armSettle();
      }
      return;
    }

    if (!isNew) return;

    const prior = this.lastAnchoredMsg;
    this.lastAnchoredMsg = newEl;
    this.lastAnchoredText = newEl.textContent;

    // A real submit *appends* to the current thread, so the previous trailing message stays in
    // the DOM. Navigating to a different thread via the sidebar swaps out the whole message
    // list instead, so the previous trailing message gets unmounted — re-enter the settle
    // window instead of anchoring, since the newly-swapped-in thread's history may still be
    // loading in incrementally (indistinguishable from real appends otherwise).
    if (prior && !document.contains(prior)) {
      this.settling = true;
      this.armSettle();
      return;
    }

    // No prior at all: brand-new-chat first prompt or sidebar nav from a message-less page
    // (see the lastSubmitAt comment). Without a recent submit signal, park the element for a
    // late-arriving handleSubmit and re-enter the settle window so the rest of an incoming
    // thread's history rebaselines silently instead of anchoring.
    if (!prior && Date.now() - this.lastSubmitAt >= SUBMIT_CORROBORATION_MS) {
      this.pendingFirstMsg = newEl;
      this.pendingFirstMsgAt = Date.now();
      this.settling = true;
      this.armSettle();
      return;
    }

    this.pendingFirstMsg = null;
    this.cb?.onAnchorReady(resolveAnchor(newEl));
    this.watchForDone();
  }

  private watchForDone() {
    this.doneObserver?.disconnect();
    // data-is-streaming flips "true" → "false" when the response completes
    this.doneObserver = new MutationObserver(() => {
      const streaming = document.querySelector('[data-is-streaming="true"]');
      if (!streaming) {
        this.cb?.onDone();
        this.doneObserver?.disconnect();
      }
    });
    this.doneObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-is-streaming'] });
  }
}
