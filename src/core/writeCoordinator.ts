import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ApprovalRequest, PermissionDecision } from "./types.js";

export type ApprovalHandler = (request: ApprovalRequest) => Promise<PermissionDecision>;

/** Stands in for the hash of a file that does not exist, so "I saw it gone" is a state too. */
export const MISSING_FILE_HASH = "missing";

export type WriteOutcome<T> = { ok: true; value: T } | { ok: false; refusal: string };

export type WithWriteOptions<T> = {
  /** Path as the agent knows it; defaults to the absolute path. */
  display?: (absolutePath: string) => string;
  /** A write that reports failure through its value must not count as seen. */
  committed?: (value: T) => boolean;
};

export function hashBytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function hashFile(absolutePath: string): Promise<string> {
  try {
    return hashBytes(await readFile(absolutePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
      return MISSING_FILE_HASH;
    }
    throw error;
  }
}

export class WriteCoordinator {
  private readonly seen = new Map<string, Map<string, string>>();
  private readonly lastWriter = new Map<string, { agentKey: string; hash: string }>();
  private tail: Promise<unknown> = Promise.resolve();

  /** Partial reads count, using the whole file's hash. */
  recordSeen(agentKey: string, absolutePath: string, contentHash: string): void {
    let files = this.seen.get(agentKey);
    if (!files) {
      files = new Map();
      this.seen.set(agentKey, files);
    }
    files.set(absolutePath, contentHash);
  }

  /**
   * Runs check-and-write as one serialised step. Returns the refusal text
   * instead of calling `write` when a file is stale for this agent. With several
   * paths nothing is written unless every one of them is current.
   */
  withWrite<T>(
    agentKey: string,
    absolutePath: string | readonly string[],
    write: () => Promise<T>,
    options: WithWriteOptions<T> = {}
  ): Promise<WriteOutcome<T>> {
    const paths = typeof absolutePath === "string" ? [absolutePath] : [...absolutePath];
    const display = options.display ?? ((value: string) => value);
    const step = this.tail.then(async (): Promise<WriteOutcome<T>> => {
      for (const target of paths) {
        const refusal = await this.refusalFor(agentKey, target, display(target));
        if (refusal) {
          return { ok: false, refusal };
        }
      }
      const value = await write();
      if (options.committed?.(value) ?? true) {
        await this.recordWrite(agentKey, paths);
      }
      return { ok: true, value };
    });
    this.tail = step.then(
      () => undefined,
      () => undefined
    );
    return step;
  }

  private async refusalFor(agentKey: string, absolutePath: string, label: string): Promise<string | null> {
    const current = await hashFile(absolutePath);
    const known = this.seen.get(agentKey)?.get(absolutePath);
    const writer = this.lastWriter.get(absolutePath);

    if (known !== undefined) {
      if (known === current) {
        return null;
      }
      if (current === MISSING_FILE_HASH) {
        return `${label} was deleted since you last read it. Read it again to confirm, then retry.`;
      }
      const by = writer && writer.agentKey !== agentKey && writer.hash === current ? ` (${writer.agentKey} wrote it)` : "";
      return `${label} changed since you last read it${by}. Read it again, then retry.`;
    }

    if (writer && writer.agentKey !== agentKey) {
      return `${label} was written by ${writer.agentKey} and you have not read it. Read it, then retry.`;
    }
    return null;
  }

  private async recordWrite(agentKey: string, paths: string[]): Promise<void> {
    for (const target of paths) {
      const hash = await hashFile(target).catch(() => null);
      if (hash === null) {
        this.lastWriter.delete(target);
        this.seen.get(agentKey)?.delete(target);
        continue;
      }
      this.lastWriter.set(target, { agentKey, hash });
      this.recordSeen(agentKey, target, hash);
    }
  }
}

/** One prompt is open at a time, in request order, whatever a handler does. */
export function serializeApprovals(handler: ApprovalHandler): ApprovalHandler {
  let tail: Promise<unknown> = Promise.resolve();
  return (request) => {
    const turn = tail.then(async (): Promise<PermissionDecision> => {
      if (request.signal?.aborted) {
        return "deny";
      }
      return await handler(request);
    });
    tail = turn.then(
      () => undefined,
      () => undefined
    );
    return turn;
  };
}
