// What a DeepSeek call actually costs this service, versus what the runtime says it costs.
//
// The runtime (pi) prices every turn from its own static table, which is the *peak* DeepSeek price
// ($0.30 input / $0.006 cache read / $1.20 output per million tokens). DeepSeek bills this key on a
// two-tier clock instead: off-peak calls are exactly half the peak price. So every `usage.cost` the
// runtime writes — into the session files and into the per-run report — is a peak-price number, and
// a run that happened off-peak was really charged half of it.
//
// This module is the one place that knows the clock. It does not touch the raw usage numbers or the
// session files; it only turns a stored peak-price cost into the amount DeepSeek billed.
//
// Known gap: only weekends are treated as off-peak days. DeepSeek also halves the price on Chinese
// statutory holidays, and those move every year — hard-coding a holiday calendar here would go stale
// silently, so it is deliberately left out. A holiday call is therefore billed at the peak (higher)
// price in our ledger: we over-count, never under-count.

const BEIJING_OFFSET_MINUTES = 8 * 60; // Beijing is UTC+8, year round.
// Peak windows on a Beijing working day, as minutes from midnight: 09:00–12:00 and 14:00–18:00.
// The endpoints are half-open (from inclusive, to exclusive), so 09:00 is peak and 12:00 / 18:00 are
// already off-peak.
const PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
];

// Off-peak is everything a peak window does not cover, plus the whole weekend. The instant may be a
// Date, an ISO string, or epoch milliseconds; anything unparseable is treated as *not* off-peak so a
// cost we cannot place stays at the higher price.
export function isOffPeak(at) {
  const instant = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(instant.getTime())) return false;
  // Shift the instant into Beijing wall-clock time and read it back through the UTC accessors, so
  // there is no dependency on the host machine's own timezone.
  const beijing = new Date(instant.getTime() + BEIJING_OFFSET_MINUTES * 60 * 1000);
  const weekday = beijing.getUTCDay(); // 0 = Sunday … 6 = Saturday
  if (weekday === 0 || weekday === 6) return true;
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  return !PEAK_WINDOWS.some(([from, to]) => minutes >= from && minutes < to);
}

// Only DeepSeek is billed on the clock; every other provider keeps the runtime's price.
export function isDeepSeek(provider) {
  return typeof provider === 'string' && provider.toLowerCase().includes('deepseek');
}

// The multiplier to apply to a peak-price cost: 0.5 for an off-peak DeepSeek call, 1 otherwise.
export function priceFactor({ provider, at }) {
  return isDeepSeek(provider) && isOffPeak(at) ? 0.5 : 1;
}

// A stored peak-price cost, re-priced to what DeepSeek actually billed for that turn.
export function offPeakCost(cost, { provider, at }) {
  if (typeof cost !== 'number' || Number.isNaN(cost)) return cost;
  return cost * priceFactor({ provider, at });
}

// What a subscription run would have cost at API list prices (USD per million tokens: uncached
// input, cached input, output). A subscription run costs no money per run, so its real cost is 0;
// this is the number that lets it be compared with a pay-per-token run (cost report, 2026-09-29).
// Prices from the official pages as recorded in Hwiki openai/api-model-pricing (checked
// 2026-09-23) and research/2026-09-23-executor-recheck.md. A model missing here gets no
// equivalent cost rather than a guessed one.
// A fourth number, where given, is the cache-write price: Claude Code writes its prompt cache with
// the 1-hour TTL, billed at twice the input price. Sonnet 5.5 is $2 / $10 (Hwiki
// anthropic/claude-sonnet-5-5-release-id-pricing-effort, same price as Sonnet 5); cache read is
// 0.1x input as for every Claude model.
// GPT-6.1 Sol, GPT-6 Sol and GPT-6 Astra from their developers.openai.com model pages, checked
// 2026-10-01 (Hwiki ai-benchmarks/which-model-for-standard-and-heavy-per-cli-backend-2026-10).
export const LIST_PRICES = Object.freeze({
  'gpt-6.1-sol': [2, 0.1, 10],
  'gpt-6-sol': [2, 0.2, 10],
  'gpt-6-astra': [10, 1, 50],
  'gpt-6-luna': [0.1, 0.01, 0.5],
  'gpt-5.6-luna': [0.2, 0.02, 1.2],
  'gpt-5.6-terra': [2, 0.2, 12],
  'grok-4.7': [2, 0.5, 6],
  'claude-sonnet-5-5': [2, 0.2, 10, 4],
});

export function equivalentCost(model, { input = 0, cacheRead = 0, cacheWrite = 0, output = 0 } = {}) {
  const price = LIST_PRICES[model];
  if (!price) return null;
  return (input * price[0] + cacheRead * price[1] + cacheWrite * (price[3] ?? price[0]) + output * price[2]) / 1e6;
}
