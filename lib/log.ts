// Always-on production diagnostics (no dev-flag gate): lets early testers report exactly
// what they see in DevTools (content script) or the service worker inspector (background)
// when troubleshooting "no ads after prompting" instead of guessing blind.
const PREFIX = '[Chatwait]';

// Millisecond-precision wall-clock time (DevTools' own per-line timestamp only goes to the
// second) so two log lines a few hundred ms apart — e.g. "submit" vs "ad shown" — can be told
// apart when comparing a pasted console dump against expected timing.
function timestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export const log = {
  info: (...args: unknown[]) => console.log(PREFIX, timestamp(), ...args),
  warn: (...args: unknown[]) => console.warn(PREFIX, timestamp(), ...args),
};
