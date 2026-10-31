export type Sampling = { temperature: number; topP: number; topK: number };

/**
 * The sampling each family's authors publish for coding work. A single
 * low temperature for every model sends Qwen into repetition loops and makes
 * gpt-oss noticeably worse; matching the published values fixes both.
 */
const profiles: Array<{ match: RegExp; sampling: Sampling }> = [
  { match: /qwen|qwq/i, sampling: { temperature: 0.7, topP: 0.8, topK: 20 } },
  { match: /gpt-oss/i, sampling: { temperature: 1.0, topP: 1.0, topK: 0 } },
  { match: /gemma/i, sampling: { temperature: 1.0, topP: 0.95, topK: 64 } },
  { match: /devstral|mistral|codestral/i, sampling: { temperature: 0.15, topP: 0.95, topK: 0 } },
  { match: /glm/i, sampling: { temperature: 0.6, topP: 0.95, topK: 0 } }
];

const fallback: Sampling = { temperature: 0.3, topP: 0.9, topK: 20 };

/** Explicit PATCHPILOT_* settings always win over the family profile. */
export function samplingFor(model: string, env: NodeJS.ProcessEnv = process.env): Sampling {
  const base = profiles.find((profile) => profile.match.test(model))?.sampling ?? fallback;
  return {
    temperature: readNumber(env.PATCHPILOT_TEMPERATURE) ?? base.temperature,
    topP: readNumber(env.PATCHPILOT_TOP_P) ?? base.topP,
    topK: readNumber(env.PATCHPILOT_TOP_K) ?? base.topK
  };
}

function readNumber(value: string | undefined): number | null {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
