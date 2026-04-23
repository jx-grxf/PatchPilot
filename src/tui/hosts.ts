import { networkInterfaces } from "node:os";
import { defaultOllamaPort, defaultOllamaUrl, normalizeOllamaBaseUrl } from "../core/ollama.js";

export type OllamaHost = {
  label: string;
  url: string;
  source: "default" | "env" | "current" | "discovered";
  version?: string;
};

export function getOllamaHostCandidates(currentUrl: string): OllamaHost[] {
  const hosts: OllamaHost[] = [];

  hosts.push({
    label: "local",
    url: defaultOllamaUrl,
    source: "default"
  });

  const envHost = process.env.PATCHPILOT_OLLAMA_URL || process.env.OLLAMA_HOST;
  if (envHost) {
    hosts.push({
      label: "env",
      url: normalizeOllamaUrl(envHost),
      source: "env"
    });
  }

  if (currentUrl && normalizeOllamaUrl(currentUrl) !== defaultOllamaUrl) {
    hosts.push({
      label: "current",
      url: normalizeOllamaUrl(currentUrl),
      source: "current"
    });
  }

  return dedupeHosts(hosts);
}

export async function discoverOllamaHosts(currentUrl: string): Promise<OllamaHost[]> {
  const candidates = getOllamaHostCandidates(currentUrl);
  const verifiedCandidates = await runPool(candidates, 8, async (candidate) =>
    checkOllamaHost(candidate.url, {
      label: candidate.label,
      source: candidate.source,
      timeoutMs: 350
    })
  );
  const discoveredHosts = await scanLanOllamaHosts();
  return dedupeHosts([
    ...verifiedCandidates.filter((host): host is OllamaHost => host !== null),
    ...discoveredHosts
  ]);
}

export function normalizeOllamaUrl(value: string): string {
  return normalizeOllamaBaseUrl(value);
}

export async function checkOllamaHost(
  value: string,
  options: {
    label?: string;
    source?: OllamaHost["source"];
    timeoutMs?: number;
  } = {}
): Promise<OllamaHost | null> {
  const url = normalizeOllamaUrl(value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 500);

  try {
    const response = await fetch(`${url}/api/version`, {
      signal: controller.signal,
      headers: {
        accept: "application/json"
      }
    });

    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as { version?: unknown };
    if (typeof body.version !== "string" || body.version.length === 0) {
      return null;
    }

    return {
      label: options.label ?? `ollama-${new URL(url).hostname}`,
      url,
      source: options.source ?? "discovered",
      version: body.version
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function getPrivateNetworkAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((interfaces) => interfaces ?? [])
    .filter((networkInterface) => networkInterface.family === "IPv4" && !networkInterface.internal)
    .map((networkInterface) => networkInterface.address)
    .filter(isPrivateIpAddress);
}

function getPrivateNetworkPrefixes(): string[] {
  const prefixes = getPrivateNetworkAddresses()
    .map((address) => address.split(".").slice(0, 3).join("."))
    .filter((prefix, index, prefixes) => prefixes.indexOf(prefix) === index);

  return prefixes.sort((left, right) => scoreNetworkPrefix(right) - scoreNetworkPrefix(left));
}

async function scanLanOllamaHosts(): Promise<OllamaHost[]> {
  const prefixes = getPrivateNetworkPrefixes();
  const discoveredHosts: OllamaHost[] = [];

  for (const prefix of prefixes.filter(shouldScanPrefix).slice(0, 1)) {
    const urls = Array.from({ length: 254 }, (_, index) => `http://${prefix}.${index + 1}:${defaultOllamaPort}`);
    const results = await runPool(urls, 96, (url) =>
      checkOllamaHost(url, {
        label: `ollama-${new URL(url).hostname}`,
        source: "discovered",
        timeoutMs: 180
      })
    );
    for (const host of results.filter((result): result is OllamaHost => result !== null)) {
      discoveredHosts.push(host);
    }
  }

  return discoveredHosts;
}

function shouldScanPrefix(prefix: string): boolean {
  return prefix !== "192.168.56" && !prefix.startsWith("172.");
}

function scoreNetworkPrefix(prefix: string): number {
  if (prefix.startsWith("192.168.") && prefix !== "192.168.56") {
    return 30;
  }

  if (prefix.startsWith("10.")) {
    return 20;
  }

  if (prefix.startsWith("172.")) {
    return 10;
  }

  return 0;
}

async function runPool<Input, Output>(
  inputs: Input[],
  concurrency: number,
  worker: (input: Input) => Promise<Output>
): Promise<Output[]> {
  const results: Output[] = [];
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < inputs.length) {
      const input = inputs[nextIndex];
      nextIndex += 1;
      results.push(await worker(input));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => runWorker()));
  return results;
}

function isPrivateIpAddress(address: string): boolean {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(address);
}

function dedupeHosts(hosts: OllamaHost[]): OllamaHost[] {
  const seenUrls = new Set<string>();
  return hosts.filter((host) => {
    if (seenUrls.has(host.url)) {
      return false;
    }

    seenUrls.add(host.url);
    return true;
  });
}
