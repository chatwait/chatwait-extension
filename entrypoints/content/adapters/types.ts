export interface PromptAdapter {
  host: string;
  start(cb: PromptCallbacks): void;
  stop(): void;
  hostAdVisible(): boolean;
}

export interface PromptCallbacks {
  /** User hit send — start impression timing */
  onSubmit(): void;
  /** Injection point appeared in DOM — show card before this element */
  onAnchorReady(el: HTMLElement): void;
  /** The host page rebuilt the DOM around the user message (e.g. Gemini's transient →
   * permanent turn swap), so the card's original anchor was discarded. Move the already
   * shown card to sit after this new element without refetching the ad or restarting timing.
   * No-op if no card is currently shown. */
  onReanchor?(el: HTMLElement): void;
  /** Response complete — stop impression timing; card itself stays visible until dismissed */
  onDone(): void;
}

export interface AdCreative {
  id: string;
  text: string;
  url: string;
  sponsor_name: string;
  icon_url?: string;
  is_house_ad?: boolean;
  kind?: 'onboarding';
  /** Per-device serving grant minted by ads-bundle (which requires device credentials);
   * the events endpoint refuses to bill an impression without a matching one. Absent only
   * on local fallback/onboarding ads, which never bill. */
  ad_token?: string;
}
