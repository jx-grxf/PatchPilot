export function selectableModels(query: string, models: string[], labelForModel: (model: string) => string = (model) => model): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return models;
  }

  return models
    .map((model) => ({
      model,
      score: scoreModelMatch(model, normalizedQuery, labelForModel(model))
    }))
    .filter((item): item is { model: string; score: number } => item.score !== null)
    .sort((left, right) => left.score - right.score || left.model.localeCompare(right.model))
    .map((item) => item.model);
}

function scoreModelMatch(model: string, query: string, label: string): number | null {
  const normalizedModel = `${model} ${label}`.toLowerCase();
  const normalizedId = model.toLowerCase();
  const normalizedLabel = label.toLowerCase();
  if (normalizedId === query || normalizedLabel === query) {
    return 0;
  }

  if (normalizedId.startsWith(query) || normalizedLabel.startsWith(query)) {
    return 1;
  }

  if (normalizedModel.includes(query)) {
    return 2 + normalizedModel.indexOf(query) / 1000;
  }

  const tokens = query.split(/[\s/:_-]+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => normalizedModel.includes(token)) ? 10 : null;
}
