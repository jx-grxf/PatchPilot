import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import { OllamaClient, defaultOllamaPort, defaultOllamaUrl, normalizeOllamaBaseUrl, type OllamaRunningModel } from "../core/ollama.js";

const execFileAsync = promisify(execFile);
const hostDiscoveryCacheTtlMs = 20_000;
const hostDetailsCacheTtlMs = 15_000;

type TailscalePeer = {
  DNSName?: unknown;
  HostName?: unknown;
  TailscaleIPs?: unknown;
  OS?: unknown;
  Online?: unknown;
};

type TailscaleStatusResponse = {
  Peer?: Record<string, TailscalePeer>;
};

export type OllamaHostKind = "local" | "lan" | "tailscale" | "manual";
export type OllamaHostSource = "default" | "env" | "current" | "discovered" | "tailscale" | "manual";

export type OllamaHost = {
  label: string;
  deviceName: string;
  hostname: string;
  url: string;
  source: OllamaHostSource;
  kind: OllamaHostKind;
  version?: string;
  os?: string;
  tailscaleName?: string;
  address?: string;
};

export type OllamaHostDetails = {
  host: OllamaHost;
  models: string[];
  runningModels: OllamaRunningModel[];
  fetchedAt: number;
};

let lastDiscoveryCache: {
  currentUrl: string;
  expiresAt: number;
  hosts: OllamaHost[];
} | null = null;

const hostDetailsCache = new Map<string, { expiresAt: number; details: OllamaHostDetails }>();

export function getOllamaHostCandidates(currentUrl: string): OllamaHost[] {
  const hosts: OllamaHost[] = [];

  hosts.push(buildHostCandidate(defaultOllamaUrl, { label: "local", source: "default" }));

  const envHost = process.env.PATCHPILOT_OLLAMA_URL || process.env.OLLAMA_HOST;
  if (envHost) {
    hosts.push(buildHostCandidate(envHost, { label: "env", source: "env" }));
  }

  if (currentUrl && normalizeOllamaUrl(currentUrl) !== defaultOllamaUrl) {
    hosts.push(buildHostCandidate(currentUrl, { label: "current", source: "current" }));
  }

  return dedupeHosts(hosts);
}

export async function discoverOllamaHosts(
  currentUrl: string,
  options: {
    refresh?: boolean;
  } = {}
): Promise<OllamaHost[]> {
  const normalizedCurrentUrl = normalizeOllamaUrl(currentUrl || defaultOllamaUrl);
  if (!options.refresh && lastDiscoveryCache && lastDiscoveryCache.currentUrl === normalizedCurrentUrl && lastDiscoveryCache.expiresAt > Date.now()) {
    return lastDiscoveryCache.hosts;
  }

  const candidates = getOllamaHostCandidates(normalizedCurrentUrl);
  const [verifiedCandidates, discoveredLanHosts, discoveredTailscaleHosts] = await Promise.all([
    runPool(candidates, 8, (candidate) =>
      checkOllamaHost(candidate.url, {
        ...candidate,
        timeoutMs: 350
      })
    ),
    scanLanOllamaHosts(),
    discoverTailscaleOllamaHosts()
  ]);

  const hosts = dedupeHosts([
    ...verifiedCandidates.filter((host): host is OllamaHost => host !== null),
    ...discoveredTailscaleHosts,
    ...discoveredLanHosts
  ]);
  lastDiscoveryCache = {
    currentUrl: normalizedCurrentUrl,
    expiresAt: Date.now() + hostDiscoveryCacheTtlMs,
    hosts
  };
  return hosts;
}

export function normalizeOllamaUrl(value: string): string {
  return normalizeOllamaBaseUrl(value);
}

export async function checkOllamaHost(
  value: string,
  options: Partial<OllamaHost> & {
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

    const parsedUrl = new URL(url);
    const kind = options.kind ?? classifyOllamaHost(url);
    const hostname = parsedUrl.hostname;
    const deviceName = options.deviceName ?? formatDeviceName(hostname, options.tailscaleName);
    const label = options.label ?? deviceName;

    return {
      label,
      deviceName,
      hostname,
      url,
      source: options.source ?? (kind === "tailscale" ? "tailscale" : "discovered"),
      kind,
      version: body.version,
      os: options.os,
      tailscaleName: options.tailscaleName,
      address: options.address ?? (isIpAddress(hostname) ? hostname : undefined)
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function startLocalOllamaAppAndWait(options: { timeoutMs?: number } = {}): Promise<OllamaHost | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  await execFileAsync("open", ["-a", "Ollama"], {
    timeout: 1200,
    windowsHide: true
  }).catch(() => undefined);

  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  while (Date.now() < deadline) {
    const host = await checkOllamaHost("local", {
      label: "local",
      source: "default",
      kind: "local",
      timeoutMs: 500
    });
    if (host) {
      return host;
    }

    await delay(350);
  }

  return null;
}

export async function readOllamaHostDetails(host: OllamaHost, refresh = false): Promise<OllamaHostDetails> {
  const cacheKey = host.url;
  const cachedEntry = hostDetailsCache.get(cacheKey);
  if (!refresh && cachedEntry && cachedEntry.expiresAt > Date.now()) {
    return cachedEntry.details;
  }

  const client = new OllamaClient(host.url);
  const [models, runningModels] = await Promise.all([
    client.listModels(),
    client.listRunningModels().catch(() => [])
  ]);

  const details: OllamaHostDetails = {
    host,
    models,
    runningModels,
    fetchedAt: Date.now()
  };
  hostDetailsCache.set(cacheKey, {
    expiresAt: Date.now() + hostDetailsCacheTtlMs,
    details
  });
  return details;
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

export function classifyOllamaHost(value: string): OllamaHostKind {
  const normalizedUrl = normalizeOllamaUrl(value);
  const hostname = new URL(normalizedUrl).hostname.toLowerCase();
  if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]") {
    return "local";
  }

  if (isTailscaleHostname(hostname) || isTailscaleIpAddress(hostname)) {
    return "tailscale";
  }

  if (isPrivateIpAddress(hostname)) {
    return "lan";
  }

  return "manual";
}

function buildHostCandidate(
  value: string,
  options: {
    label: string;
    source: OllamaHostSource;
    deviceName?: string;
    os?: string;
    tailscaleName?: string;
    address?: string;
  }
): OllamaHost {
  const url = normalizeOllamaUrl(value);
  const parsedUrl = new URL(url);
  const kind = classifyOllamaHost(url);
  return {
    label: options.label,
    deviceName: options.deviceName ?? formatDeviceName(parsedUrl.hostname, options.tailscaleName),
    hostname: parsedUrl.hostname,
    url,
    source: options.source,
    kind,
    os: options.os,
    tailscaleName: options.tailscaleName,
    address: options.address ?? (isIpAddress(parsedUrl.hostname) ? parsedUrl.hostname : undefined)
  };
}

function getPrivateNetworkAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((interfaces) => interfaces ?? [])
    .filter((networkInterface) => networkInterface.family === "IPv4" && !networkInterface.internal)
    .map((networkInterface) => networkInterface.address)
    .filter((address) => isPrivateIpAddress(address) && !isTailscaleIpAddress(address));
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
        label: `lan-${new URL(url).hostname}`,
        source: "discovered",
        kind: "lan",
        timeoutMs: 180
      })
    );
    for (const host of results.filter((result): result is OllamaHost => result !== null)) {
      discoveredHosts.push(host);
    }
  }

  return discoveredHosts;
}

async function discoverTailscaleOllamaHosts(): Promise<OllamaHost[]> {
  const peerCandidates = await getTailscalePeerCandidates();
  if (peerCandidates.length === 0) {
    return [];
  }

  const results = await runPool(peerCandidates, 16, (candidate) =>
    checkOllamaHost(candidate.url, {
      ...candidate,
      timeoutMs: 350
    })
  );
  return dedupeHosts(results.filter((host): host is OllamaHost => host !== null));
}

async function getTailscalePeerCandidates(): Promise<OllamaHost[]> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
      timeout: 1200,
      maxBuffer: 1_000_000,
      windowsHide: true
    });
    const payload = JSON.parse(stdout) as TailscaleStatusResponse;
    const peers = Object.values(payload.Peer ?? {});
    return dedupeHosts(
      peers.flatMap((peer) => {
        if (peer.Online === false) {
          return [];
        }

        const tailscaleName = trimTailscaleName(asString(peer.DNSName));
        const deviceName = formatDeviceName(asString(peer.HostName), tailscaleName);
        const os = asString(peer.OS) ?? undefined;
        const tailscaleIps = asStringArray(peer.TailscaleIPs).filter(isTailscaleIpAddress);
        const candidates: OllamaHost[] = [];

        if (tailscaleName) {
          candidates.push(
            buildHostCandidate(`http://${tailscaleName}:${defaultOllamaPort}`, {
              label: deviceName,
              source: "tailscale",
              deviceName,
              os,
              tailscaleName,
              address: tailscaleIps[0]
            })
          );
        }

        for (const address of tailscaleIps) {
          candidates.push(
            buildHostCandidate(`http://${address}:${defaultOllamaPort}`, {
              label: deviceName,
              source: "tailscale",
              deviceName,
              os,
              tailscaleName,
              address
            })
          );
        }

        return candidates;
      })
    );
  } catch {
    return [];
  }
}

function shouldScanPrefix(prefix: string): boolean {
  return prefix !== "192.168.56" && !isDockerBridgePrefix(prefix) && isPrivatePrefix(prefix);
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

function isPrivatePrefix(prefix: string): boolean {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(`${prefix}.`);
}

function isDockerBridgePrefix(prefix: string): boolean {
  return prefix === "172.17.0" || prefix === "172.18.0";
}

function isTailscaleIpAddress(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function isTailscaleHostname(hostname: string): boolean {
  return hostname.endsWith(".ts.net");
}

function isIpAddress(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function formatDeviceName(hostname: string | null | undefined, tailscaleName?: string): string {
  const candidate = (hostname || tailscaleName || "").trim();
  if (!candidate) {
    return "host";
  }

  const normalizedCandidate = trimTailscaleName(candidate) ?? candidate;
  if (normalizedCandidate === "127.0.0.1" || normalizedCandidate === "localhost") {
    return "local";
  }

  if (isIpAddress(normalizedCandidate)) {
    return normalizedCandidate;
  }

  return normalizedCandidate.split(".")[0] || normalizedCandidate;
}

function trimTailscaleName(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.replace(/\.$/, "");
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString).filter((entry): entry is string => entry !== null) : [];
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
