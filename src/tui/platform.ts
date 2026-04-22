export function isMacOS(): boolean {
  return process.platform === "darwin";
}

export function isLocalOllamaUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return ["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname);
  } catch {
    return false;
  }
}
