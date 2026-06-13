/**
 * Public Gemini API token pricing (USD per 1M tokens), used to show how much
 * a gemini-wrapper session *would* have cost on the paid API — i.e. what the
 * free Gemini Web route saved. Prices verified June 2026 from
 * ai.google.dev/gemini-api/docs/pricing.
 */
export type TokenPrice = {
  inputPerMillion: number;
  outputPerMillion: number;
};

const pricingTable: Array<{ pattern: RegExp; price: TokenPrice }> = [
  // Gemini 3.5 Flash.
  { pattern: /3[._-]?5.*flash/i, price: { inputPerMillion: 1.5, outputPerMillion: 9 } },
  // Gemini 3.x Pro tier.
  { pattern: /(gemini-?3|3\.\d).*pro|gemini-?3-pro/i, price: { inputPerMillion: 2, outputPerMillion: 12 } },
  // Gemini 2.5 Pro.
  { pattern: /2[._-]?5.*pro|gemini-pro|^pro$/i, price: { inputPerMillion: 1.25, outputPerMillion: 10 } },
  // Gemini 3.1 Flash-Lite.
  { pattern: /3[._-]?1.*flash[-_ ]?lite/i, price: { inputPerMillion: 0.25, outputPerMillion: 1.5 } },
  // Gemini 2.5 Flash-Lite.
  { pattern: /flash[-_ ]?lite/i, price: { inputPerMillion: 0.1, outputPerMillion: 0.4 } },
  // Gemini 2.5 / 2.0 Flash.
  { pattern: /flash/i, price: { inputPerMillion: 0.3, outputPerMillion: 2.5 } },
];

// "auto" and unknown models: assume the current Flash tier.
const fallbackPrice: TokenPrice = { inputPerMillion: 1.5, outputPerMillion: 9 };

/** Resolve the public API price for a Gemini model id. */
export function geminiPriceFor(model: string): TokenPrice {
  for (const entry of pricingTable) {
    if (entry.pattern.test(model)) {
      return entry.price;
    }
  }

  return fallbackPrice;
}

/** Estimate the paid-API cost (USD) of the given token counts for a model. */
export function estimateGeminiCost(promptTokens: number, responseTokens: number, model: string): number {
  const price = geminiPriceFor(model);
  const safePrompt = Math.max(0, promptTokens || 0);
  const safeResponse = Math.max(0, responseTokens || 0);
  return (safePrompt / 1_000_000) * price.inputPerMillion + (safeResponse / 1_000_000) * price.outputPerMillion;
}

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
