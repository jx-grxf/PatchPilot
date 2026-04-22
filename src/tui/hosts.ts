import { networkInterfaces } from "node:os";
import { Socket } from "node:net";

export type OllamaHost = {
  label: string;
  url: string;
  source: "default" | "env" | "suggested";
};

const localOllamaUrl = "http://127.0.0.1:11434";

export function getOllamaHostCandidates(currentUrl: string): OllamaHost[] {
  const hosts: OllamaHost[] = [];

  hosts.push({
    label: "local",
    url: localOllamaUrl,
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

  if (currentUrl && currentUrl !== localOllamaUrl) {
    hosts.push({
      label: "current",
      url: normalizeOllamaUrl(currentUrl),
      source: "suggested"
    });
  }

  for (const ipAddress of getPrivateNetworkAddresses()) {
    hosts.push({
      label: `lan-${ipAddress}`,
      url: `http://${ipAddress}:11434`,
      source: "suggested"
    });
  }

  return dedupeHosts(hosts);
}

export async function discoverOllamaHosts(currentUrl: string): Promise<OllamaHost[]> {
  const candidates = getOllamaHostCandidates(currentUrl);
  const discoveredHosts = await scanLanOllamaHosts();
  return dedupeHosts([...candidates, ...discoveredHosts]);
}

export function normalizeOllamaUrl(value: string): string {
  if (!value || value === "local" || value === "localhost") {
    return localOllamaUrl;
  }

  if (/^https?:\/\//i.test(value)) {
    return value.replace(/\/$/, "");
  }

  return `http://${value}`.replace(/\/$/, "");
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
    const urls = Array.from({ length: 254 }, (_, index) => `http://${prefix}.${index + 1}:11434`);
    const results = await runPool(urls, 96, probeOllamaHost);
    for (const url of results.filter((result): result is string => typeof result === "string")) {
      discoveredHosts.push({
        label: new URL(url).hostname,
        url,
        source: "suggested"
      });
    }
  }

  return discoveredHosts;
}

async function probeOllamaHost(url: string): Promise<string | null> {
  try {
    const parsedUrl = new URL(url);
    const isOpen = await isTcpPortOpen(parsedUrl.hostname, Number.parseInt(parsedUrl.port || "11434", 10), 120);
    return isOpen ? url : null;
  } catch {
    return null;
  }
}

function isTcpPortOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;

    function finish(result: boolean): void {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(result);
    }

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
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
