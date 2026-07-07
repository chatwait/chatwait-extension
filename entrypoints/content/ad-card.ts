import type { AdCreative } from "./adapters/types";

/** House and onboarding ads have no advertiser-supplied icon_url — show the bundled Chatwait
 * mark (public/chatwait-icon-round.svg, web-accessible per wxt.config.ts) instead of falling
 * back to a plain sponsor-initial letter. */
function iconSrc(ad: AdCreative): string | undefined {
  if (ad.icon_url) return ad.icon_url;
  if (ad.is_house_ad || ad.kind === "onboarding") return browser.runtime.getURL("/chatwait-icon-round.svg");
  return undefined;
}

const CARD_HTML = (ad: AdCreative) => `
  <style>
    :host { all: initial; }
    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 2px;
      margin: 4px 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 16px;
      line-height: 1.45;
      border-bottom: 1px solid rgba(127,127,142,0.22);
    }
    .icon {
      flex-shrink: 0;
      width: 20px;
      height: 20px;
      border-radius: 4px;
      background: #2563eb;
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      text-transform: uppercase;
    }
    .icon.house { background: #10b981; }
    .icon.has-img { background: transparent; }
    .icon img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .text { flex: 1; min-width: 0; color: rgba(60,60,67,0.85); }
    .text a { color: #2563eb; text-decoration: none; font-weight: 500; }
    .text a:hover { text-decoration: underline; }
    .dismiss {
      background: none;
      border: none;
      color: rgba(60,60,67,0.4);
      cursor: pointer;
      font-size: 15px;
      line-height: 1;
      padding: 2px 4px;
      border-radius: 6px;
      flex-shrink: 0;
      opacity: 0;
      transition: opacity 0.1s ease;
    }
    .row:hover .dismiss, .dismiss:focus-visible { opacity: 1; }
    .dismiss:hover { color: rgba(60,60,67,0.75); background: rgba(127,127,142,0.12); }

    @media (prefers-color-scheme: dark) {
      .text { color: #d4d4d8; }
      .text a { color: #60a5fa; }
      .dismiss { color: #71717a; }
      .dismiss:hover { color: #d4d4d8; }
    }
  </style>
  <div class="row">
    <span class="icon${ad.is_house_ad || ad.kind === "onboarding" ? " house" : ""}${iconSrc(ad) ? " has-img" : ""}">${
      iconSrc(ad)
        ? `<img src="${iconSrc(ad)!.replace(/"/g, "&quot;")}" alt="" referrerpolicy="no-referrer">`
        : ad.sponsor_name.slice(0, 1)
    }</span>
    <span class="text">
      <a href="${ad.url}" target="_blank" rel="noopener noreferrer">${ad.text}</a>
    </span>
    <button class="dismiss" aria-label="Dismiss ad">×</button>
  </div>
`;

export class AdCard {
  private host: HTMLElement | null = null;

  /** Insert ad card immediately after the user message element. `onClick` fires when the
   * sponsored link itself is clicked (not the dismiss button), and is passed the anchor
   * element so the caller can rewrite `href` just before the browser navigates (e.g. to add
   * the impression id once it's known to have qualified). `onDismiss` fires when the X button
   * removes this card — the caller must stop its impression tracker there too, since removal
   * doesn't otherwise interrupt dwell tracking (which only watches tab visibility/focus, not
   * this element's presence) and a dismissed card could otherwise still silently qualify and
   * bill. Returns the rendered host element. */
  show(
    ad: AdCreative,
    afterEl: HTMLElement,
    opts?: { onClick?: (anchor: HTMLAnchorElement) => void; onDismiss?: () => void },
  ): HTMLElement {
    this.remove();
    this.host = document.createElement("div");
    this.host.setAttribute("data-chatwait", "");
    // Host has no light-DOM styling of its own, so it inherits sizing from whatever it's
    // inserted into. On gemini.google.com the message row is a flex column with
    // align-items: center, which — absent an explicit width — shrinks the host to its
    // content width and centers it instead of spanning the row (the divider line ends up
    // short and centered instead of full-width). Force block + 100% width so the host's
    // size never depends on the host page's flex/align-items choices.
    this.host.style.display = "block";
    this.host.style.width = "100%";
    const root = this.host.attachShadow({ mode: "closed" });
    root.innerHTML = CARD_HTML(ad);
    // If the icon image fails to load (network error, or the host page's CSP blocks
    // the external <img>), fall back to the sponsor-initial letter tile.
    if (iconSrc(ad)) {
      const iconEl = root.querySelector(".icon")!;
      const img = iconEl.querySelector("img");
      img?.addEventListener("error", () => {
        iconEl.classList.remove("has-img");
        iconEl.textContent = ad.sponsor_name.slice(0, 1);
      });
    }
    root
      .querySelector(".dismiss")!
      .addEventListener("click", () => {
        this.dismiss();
        opts?.onDismiss?.();
      });
    if (opts?.onClick) {
      const anchor = root.querySelector(".text a") as HTMLAnchorElement;
      anchor.addEventListener("click", () => opts.onClick!(anchor));
    }
    afterEl.after(this.host);
    return this.host;
  }

  /** Move the already-shown card to sit immediately after a new anchor element. Used when the
   * host page tears down and rebuilds the DOM around the user message (Gemini's transient →
   * permanent turn swap): the card host node itself survives the teardown as a detached node,
   * so re-inserting it keeps the same shadow root, listeners, and impression timing. Only moves
   * when it isn't already correctly positioned, so it's cheap/idempotent to call on every
   * mutation while the rebuild settles. No-op if no card is currently shown. */
  reanchor(afterEl: HTMLElement) {
    if (this.host && afterEl.nextElementSibling !== this.host) {
      afterEl.after(this.host);
    }
  }

  hide() {
    this.remove();
  }

  private remove() {
    this.host?.remove();
    this.host = null;
  }

  /** X button: removes only this card instance. No lasting state — the next prompt gets
   * its own ad and its own dismiss button. */
  private dismiss() {
    this.remove();
  }
}
