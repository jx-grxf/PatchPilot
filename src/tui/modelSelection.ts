export function selectableModels(query: string, models: string[]): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return models;
  }

  return models
    .map((model) => ({
      model,
      score: scoreModelMatch(model, normalizedQuery)
    }))
    .filter((item): item is { model: string; score: number } => item.score !== null)
    .sort((left, right) => left.score - right.score || left.model.localeCompare(right.model))
    .map((item) => item.model);
}

function scoreModelMatch(model: string, query: string): number | null {
  const normalizedModel = model.toLowerCase();
  if (normalizedModel === query) {
    return 0;
  }

  if (normalizedModel.startsWith(query)) {
    return 1;
  }

  if (normalizedModel.includes(query)) {
    return 2 + normalizedModel.indexOf(query) / 1000;
  }

  const tokens = query.split(/[\s/:_-]+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => normalizedModel.includes(token)) ? 10 : null;
}
