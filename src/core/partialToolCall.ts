/**
 * Reads a tool call that is still being generated, so the UI can show the
 * file taking shape instead of a counter. Everything here tolerates input cut
 * off at any byte; nothing is validated, because the finished call goes
 * through the repair ladder anyway.
 */
export type PartialCall = { name?: string; path?: string; body?: string };

/** Fields whose value is the text being written, in order of preference. */
const bodyFields = ["content", "new_string"];

/** Arguments as streamed JSON: `{"path": "a.ts", "content": "line 1\nline`. */
export function readPartialArguments(argumentsText: string): PartialCall {
  const path = readPartialJsonString(argumentsText, "path");
  const body = bodyFields.map((field) => readPartialJsonString(argumentsText, field)).find((value) => value !== undefined);
  return { ...(path !== undefined ? { path } : {}), ...(body !== undefined ? { body } : {}) };
}

/**
 * A call the model is printing as text, which is what a runtime streams when
 * it only parses the call after it is complete. Covers the Hermes JSON form
 * and the Qwen3-Coder XML form inside `<tool_call>`.
 */
export function readPartialToolCallText(text: string): PartialCall | null {
  const start = callStart(text);
  if (start === -1) {
    return null;
  }
  const call = text.slice(start).replace(/^<tool_call>/, "");

  const xmlName = call.match(/<function=([\w.-]+)>/)?.[1];
  if (xmlName) {
    return {
      name: xmlName,
      ...optional("path", readXmlParameter(call, "path")?.trim()),
      ...optional("body", bodyFields.map((field) => readXmlParameter(call, field)).find((value) => value !== undefined))
    };
  }

  const jsonName = readPartialJsonString(call, "name");
  const argumentsStart = call.search(/"(?:arguments|parameters)"\s*:/);
  return {
    ...optional("name", jsonName),
    ...(argumentsStart === -1 ? {} : readPartialArguments(call.slice(argumentsStart)))
  };
}

/** Text before a printed tool call; the call itself is shown as a preview. */
export function textBeforeToolCall(text: string): string {
  const start = callStart(text);
  return start === -1 ? text : text.slice(0, start);
}

/**
 * Where a printed call begins. `<function=` counts on its own because some
 * runtimes drop `<tool_call>` as a special token while detokenizing.
 */
function callStart(text: string): number {
  const starts = [text.indexOf("<tool_call>"), text.search(/<function=[\w.-]/)].filter((index) => index !== -1);
  return starts.length > 0 ? Math.min(...starts) : -1;
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function readXmlParameter(text: string, name: string): string | undefined {
  const open = `<parameter=${name}>`;
  const start = text.indexOf(open);
  if (start === -1) {
    return undefined;
  }
  const rest = text.slice(start + open.length).replace(/^\n/, "");
  const end = rest.indexOf("</parameter>");
  return end === -1 ? rest : rest.slice(0, end).replace(/\n$/, "");
}

/** Decodes a JSON string value that may not have its closing quote yet. */
function readPartialJsonString(text: string, key: string): string | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(text);
  if (!match) {
    return undefined;
  }
  let output = "";
  for (let index = match.index + match[0].length; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      return output;
    }
    if (char !== "\\") {
      output += char;
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) {
      break;
    }
    index += 1;
    if (next === "n") output += "\n";
    else if (next === "t") output += "\t";
    else if (next === "r") output += "";
    else if (next === "u") {
      const hex = text.slice(index + 1, index + 5);
      if (hex.length < 4) {
        break;
      }
      output += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
    } else output += next;
  }
  return output;
}
