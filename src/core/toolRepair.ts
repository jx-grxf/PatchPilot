import { getToolDefinition, isToolName, type JsonSchemaProperty, type ToolDefinition, type ToolName } from "./toolSchema.js";

/**
 * The repair ladder.
 *
 * Grammar-constrained decoding (L1) lives in the provider clients and makes
 * malformed JSON structurally impossible where the runtime supports it. This
 * module is everything that catches what L1 misses:
 *
 *   L2  fenced-JSON fallback — models that print a tool call instead of calling
 *   L3  coercion — alias names, synonym arguments, near-miss JSON
 *   L4  structured errors returned as tool results, never exceptions
 *   L5  loop detection — refuse an identical failing call structurally
 *   L6  intent guards — catch "shall I?" when the model was told to act
 *
 * The principle throughout: make the mistake impossible or make the correction
 * obvious. Never prompt and hope.
 */

export type RepairedToolCall = {
  name: ToolName;
  arguments: Record<string, unknown>;
  /** Which rungs of the ladder were used, for telemetry and transcript notes. */
  repairs: string[];
};

export type ToolCallProblem = {
  /** Returned to the model as a tool result so it can retry in the same turn. */
  message: string;
};

/**
 * L3 — tool name aliases.
 *
 * Models trained on shell habits and on other harnesses reach for names that
 * do not exist here. Accepting the obvious ones costs nothing and saves a
 * whole turn of correction.
 */
const toolNameAliases: Record<string, ToolName> = {
  ls: "glob",
  list: "glob",
  list_files: "glob",
  find: "glob",
  find_files: "glob",
  search: "grep",
  search_text: "grep",
  ripgrep: "grep",
  rg: "grep",
  cat: "read",
  read_file: "read",
  view: "read",
  open: "read",
  write_file: "write",
  create: "write",
  create_file: "write",
  edit_file: "edit",
  replace: "edit",
  str_replace: "edit",
  apply_patch: "edit",
  patch: "edit",
  shell: "bash",
  run: "bash",
  run_shell: "bash",
  run_command: "bash",
  exec: "bash",
  terminal: "bash",
  git: "bash",
  run_tests: "bash",
  test: "bash",
  fetch: "fetch_url",
  web_fetch: "fetch_url",
  url: "fetch_url",
  update_todo: "todo",
  todo_write: "todo",
  todowrite: "todo",
  subagent: "task",
  delegate: "task",
  agent: "task"
};

/**
 * L3 — argument synonyms, per tool.
 *
 * Same reasoning as the name aliases: a model that says `file` instead of
 * `path` understood the task perfectly and should not lose a turn over it.
 */
const argumentAliases: Partial<Record<ToolName, Record<string, string>>> = {
  read: { file: "path", filename: "path", file_path: "path", filepath: "path", start: "offset", lines: "limit" },
  write: { file: "path", file_path: "path", filepath: "path", text: "content", contents: "content", body: "content" },
  edit: {
    file: "path",
    file_path: "path",
    filepath: "path",
    find: "old_string",
    search: "old_string",
    old: "old_string",
    old_str: "old_string",
    from: "old_string",
    replace: "new_string",
    new: "new_string",
    new_str: "new_string",
    to: "new_string",
    all: "replace_all"
  },
  glob: { query: "pattern", glob: "pattern", name: "pattern", path: "pattern", max: "limit" },
  grep: { query: "pattern", search: "pattern", text: "pattern", regex: "pattern", dir: "path", directory: "path" },
  bash: { cmd: "command", script: "command", shell: "command", run: "command", desc: "description" },
  fetch_url: { link: "url", href: "url", address: "url", limit: "max_chars" },
  todo: { todos: "items", list: "items", tasks: "items" },
  task: { instruction: "prompt", task: "prompt", type: "subagent_type", agent: "subagent_type" }
};

/** L3 — resolves a model-supplied tool name to a real one. */
export function resolveToolName(raw: unknown): { name: ToolName; aliased: boolean } | null {
  if (typeof raw !== "string") {
    return null;
  }

  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (isToolName(normalized)) {
    return { name: normalized, aliased: false };
  }

  // A namespaced call like "functions.read" or "tool:grep" still names a tool.
  const tail = normalized.split(/[.:]/).pop() ?? "";
  if (isToolName(tail)) {
    return { name: tail, aliased: true };
  }

  const alias = toolNameAliases[normalized] ?? toolNameAliases[tail];
  return alias ? { name: alias, aliased: true } : null;
}

/**
 * L2 — recovers tool calls a model printed as text instead of emitting through
 * the API. This is a measured failure mode, not a hypothetical: some models
 * produce a perfectly formed call inside a markdown fence and make zero actual
 * tool calls, which reads as the model refusing to act.
 */
export function extractFencedToolCalls(content: string): Array<{ name: unknown; arguments: unknown }> {
  const calls: Array<{ name: unknown; arguments: unknown }> = [];
  const fencePattern = /```(?:json|tool_code|tool_call)?\s*\n([\s\S]*?)```/g;

  for (const match of content.matchAll(fencePattern)) {
    const parsed = parseLooseJson(match[1] ?? "");
    if (!parsed) {
      continue;
    }

    for (const candidate of Array.isArray(parsed) ? parsed : [parsed]) {
      const call = readCallShape(candidate);
      if (call) {
        calls.push(call);
      }
    }
  }

  return calls;
}

/**
 * L3 — parses JSON that is nearly valid. Local models routinely emit trailing
 * commas, single quotes, and tails cut off by the token budget.
 */
export function parseLooseJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const attempts = [trimmed, stripTrailingCommas(trimmed), quoteNormalized(stripTrailingCommas(trimmed)), closeTruncated(trimmed)];
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      continue;
    }
  }

  return null;
}

/** L3 — normalizes one raw call into a validated, schema-conforming call. */
export function repairToolCall(raw: { name: unknown; arguments: unknown }): RepairedToolCall | ToolCallProblem {
  const repairs: string[] = [];
  const resolved = resolveToolName(raw.name);
  if (!resolved) {
    return {
      message: `Unknown tool ${JSON.stringify(raw.name)}. Available tools: read, write, edit, glob, grep, bash, fetch_url, task, todo. Pick one of those and call it again.`
    };
  }

  if (resolved.aliased) {
    repairs.push(`name ${String(raw.name)} -> ${resolved.name}`);
  }

  const definition = getToolDefinition(resolved.name);
  const rawArgs = coerceArgumentObject(raw.arguments);
  if (rawArgs === null) {
    return {
      message: `Tool ${resolved.name} was called with arguments that are not an object. Send arguments as a JSON object, e.g. ${exampleCall(definition)}`
    };
  }

  const args = applyArgumentAliases(resolved.name, rawArgs, repairs);
  const validation = validateArguments(definition, args, repairs);
  if ("message" in validation) {
    return validation;
  }

  return { name: resolved.name, arguments: validation.arguments, repairs };
}

/**
 * L4 — validation failures come back as guidance, not as "invalid input".
 * Naming the next action is what turns a failed call into a corrected one.
 */
function validateArguments(
  definition: ToolDefinition,
  args: Record<string, unknown>,
  repairs: string[]
): { arguments: Record<string, unknown> } | ToolCallProblem {
  const schema = definition.inputSchema;
  const result: Record<string, unknown> = {};

  for (const required of schema.required ?? []) {
    if (args[required] === undefined || args[required] === null || args[required] === "") {
      return {
        message: `Tool ${definition.name} needs "${required}" (${schema.properties[required]?.description ?? "required"}). Call it again like ${exampleCall(definition)}`
      };
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    if (!property) {
      // Dropping an unknown key beats rejecting an otherwise usable call.
      repairs.push(`dropped unknown argument ${key}`);
      continue;
    }

    const coerced = coerceValue(value, property);
    if (coerced === undefined) {
      return {
        message: `Tool ${definition.name} argument "${key}" should be ${describeType(property)}, got ${JSON.stringify(value)}. ${property.description}`
      };
    }

    if (property.enum && typeof coerced === "string" && !property.enum.includes(coerced)) {
      return {
        message: `Tool ${definition.name} argument "${key}" must be one of: ${property.enum.join(", ")}. Got ${JSON.stringify(coerced)}.`
      };
    }

    if (coerced !== value) {
      repairs.push(`coerced ${key}`);
    }
    result[key] = coerced;
  }

  return { arguments: result };
}

/**
 * L5 — loop detection.
 *
 * A model that repeats a failing call does not stop because the prompt asked
 * it to; one measured case burned 30k tokens on ten identical commands. The
 * harness refuses the repeat and says what to change instead.
 */
export class ToolCallLoopBreaker {
  private readonly seen = new Map<string, number>();

  constructor(private readonly limit = 2) {}

  /** Returns a refusal message when this call has already failed too often. */
  check(name: ToolName, args: Record<string, unknown>): ToolCallProblem | null {
    const signature = `${name}:${stableStringify(args)}`;
    const count = this.seen.get(signature) ?? 0;
    if (count < this.limit) {
      return null;
    }

    return {
      message: `You have already called ${name} with these exact arguments ${count} times and it did not work. Do not repeat it. Change the arguments, use a different tool, or explain what is blocking you.`
    };
  }

  /** Records a failed call. Successful calls are never counted. */
  recordFailure(name: ToolName, args: Record<string, unknown>): void {
    const signature = `${name}:${stableStringify(args)}`;
    this.seen.set(signature, (this.seen.get(signature) ?? 0) + 1);
  }

  reset(): void {
    this.seen.clear();
  }
}

/**
 * L6 — intent guard.
 *
 * Some models ask permission despite an explicit instruction to act. Detecting
 * it lets the harness re-prompt once rather than ending the turn on a question
 * the user already answered by asking.
 */
export function looksLikePermissionRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (normalized.length > 400 || !normalized.includes("?")) {
    return false;
  }

  return /\b(shall i|should i|would you like me to|do you want me to|may i|can i go ahead|let me know if you want|soll ich|möchtest du)\b/.test(
    normalized
  );
}

function coerceArgumentObject(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) {
    return {};
  }

  // Some runtimes hand back the arguments object as a JSON string.
  if (typeof value === "string") {
    const parsed = parseLooseJson(value);
    return isRecord(parsed) ? parsed : null;
  }

  return isRecord(value) ? value : null;
}

function applyArgumentAliases(name: ToolName, args: Record<string, unknown>, repairs: string[]): Record<string, unknown> {
  const aliases = argumentAliases[name] ?? {};
  const schema = getToolDefinition(name).inputSchema.properties;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    const normalizedKey = key.trim().toLowerCase();
    if (schema[normalizedKey]) {
      result[normalizedKey] = value;
      continue;
    }

    const alias = aliases[normalizedKey];
    if (alias && result[alias] === undefined) {
      repairs.push(`argument ${key} -> ${alias}`);
      result[alias] = value;
      continue;
    }

    result[normalizedKey] = value;
  }

  return result;
}

function coerceValue(value: unknown, property: JsonSchemaProperty): unknown {
  switch (property.type) {
    case "string":
      return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
    case "integer":
    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) {
        return property.type === "integer" ? Math.trunc(value) : value;
      }
      const parsed = typeof value === "string" ? Number(value.trim()) : Number.NaN;
      return Number.isFinite(parsed) ? (property.type === "integer" ? Math.trunc(parsed) : parsed) : undefined;
    }
    case "boolean":
      if (typeof value === "boolean") {
        return value;
      }
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["true", "yes", "1"].includes(normalized)) return true;
        if (["false", "no", "0"].includes(normalized)) return false;
      }
      return undefined;
    case "array":
      return Array.isArray(value) ? value : undefined;
  }
}

function describeType(property: JsonSchemaProperty): string {
  return property.type === "array" ? "an array" : `a ${property.type}`;
}

/** A concrete example beats a schema dump for a model that just got it wrong. */
function exampleCall(definition: ToolDefinition): string {
  const example: Record<string, unknown> = {};
  for (const key of definition.inputSchema.required ?? []) {
    const property = definition.inputSchema.properties[key];
    example[key] =
      property?.enum?.[0] ??
      (property?.type === "integer" || property?.type === "number" ? 1 : property?.type === "boolean" ? true : property?.type === "array" ? [] : `<${key}>`);
  }

  return `${definition.name}(${JSON.stringify(example)})`;
}

function readCallShape(value: unknown): { name: unknown; arguments: unknown } | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = value.name ?? value.tool ?? value.tool_name ?? value.function;
  if (name === undefined) {
    return null;
  }

  const args = value.arguments ?? value.args ?? value.parameters ?? value.input ?? {};
  return { name: isRecord(name) ? name.name : name, arguments: isRecord(name) ? (name.arguments ?? args) : args };
}

function stripTrailingCommas(value: string): string {
  return value.replace(/,\s*([}\]])/g, "$1");
}

function quoteNormalized(value: string): string {
  // Only swap quotes that look like JSON keys or simple values, so apostrophes
  // inside real content are left alone.
  return value.replace(/'([^'\n]*)'(\s*[:,}\]])/g, '"$1"$2').replace(/([{,]\s*)'([^'\n]*)'(\s*:)/g, '$1"$2"$3');
}

/** Closes a payload cut off by the generation budget. */
function closeTruncated(value: string): string {
  let result = value.trimEnd();
  if (result.endsWith(",")) {
    result = result.slice(0, -1);
  }

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of result) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      stack.pop();
    }
  }

  if (inString) {
    result += '"';
  }

  while (stack.length > 0) {
    result += stack.pop() === "{" ? "}" : "]";
  }

  return result;
}

function stableStringify(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
