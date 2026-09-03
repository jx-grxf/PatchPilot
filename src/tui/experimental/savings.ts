/**
 * Running locally costs nothing, so the header shows what the same token
 * counts would have cost on a hosted API — the amount running locally saved.
 * The reference rate lives in the core accounting module.
 */
export { estimateCloudEquivalentCost } from "../../core/tokenAccounting.js";

/** Format a saved-cost figure for the header counter. */
export function formatSavedCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) {
    return "$0.00";
  }

  if (usd < 0.01) {
    return "<$0.01";
  }

  return `$${usd.toFixed(2)}`;
}
