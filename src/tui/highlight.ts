/**
 * Minimal syntax highlighting for terminal code blocks.
 *
 * A full highlighter (highlight.js, shiki) is megabytes of grammars to colour
 * a handful of tokens at terminal fidelity. This covers the languages a coding
 * agent actually emits and degrades to plain text for anything else, which is
 * the correct outcome rather than a failure.
 *
 * Tokenising happens per line so a streaming transcript can highlight output
 * before the block is closed.
 */

export type TokenKind = "plain" | "keyword" | "string" | "comment" | "number" | "function" | "punctuation";

export type Token = {
  text: string;
  kind: TokenKind;
};

type LanguageRules = {
  keywords: Set<string>;
  lineComment: string[];
  blockComment?: [string, string];
  stringDelimiters: string[];
};

const sharedPunctuation = /[{}()[\];,.:<>=+\-*/%!&|?~^]/;

const javascriptKeywords =
  "const let var function return if else for while do break continue class extends new this super import export from as default async await try catch finally throw typeof instanceof in of delete void yield static get set null undefined true false interface type enum implements private public protected readonly abstract satisfies keyof infer never unknown any";

const pythonKeywords =
  "def class return if elif else for while break continue import from as pass raise try except finally with lambda yield global nonlocal assert del in is not and or None True False async await match case self";

const shellKeywords = "if then else elif fi for while do done case esac function return exit local export set unset echo cd source alias";

const languages: Record<string, LanguageRules> = {
  typescript: { keywords: toSet(javascriptKeywords), lineComment: ["//"], blockComment: ["/*", "*/"], stringDelimiters: ['"', "'", "`"] },
  python: { keywords: toSet(pythonKeywords), lineComment: ["#"], stringDelimiters: ['"', "'"] },
  shell: { keywords: toSet(shellKeywords), lineComment: ["#"], stringDelimiters: ['"', "'"] },
  json: { keywords: toSet("true false null"), lineComment: [], stringDelimiters: ['"'] },
  rust: {
    keywords: toSet("fn let mut const struct enum impl trait pub use mod match if else for while loop return self Self where async await move ref dyn crate super as in break continue static unsafe type true false"),
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    stringDelimiters: ['"']
  },
  go: {
    keywords: toSet("func package import var const type struct interface map chan go defer if else for range return switch case default break continue select nil true false string int error"),
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    stringDelimiters: ['"', "`"]
  }
};

const languageAliases: Record<string, keyof typeof languages> = {
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  js: "typescript",
  jsx: "typescript",
  javascript: "typescript",
  mjs: "typescript",
  cjs: "typescript",
  py: "python",
  python: "python",
  python3: "python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  shell: "shell",
  console: "shell",
  json: "json",
  jsonc: "json",
  rs: "rust",
  rust: "rust",
  go: "go",
  golang: "go"
};

export function resolveLanguage(language: string | null | undefined): keyof typeof languages | null {
  if (!language) {
    return null;
  }

  return languageAliases[language.trim().toLowerCase()] ?? null;
}

/** True for a fenced block that is a diff rather than source code. */
export function isDiffLanguage(language: string | null | undefined): boolean {
  const normalized = language?.trim().toLowerCase() ?? "";
  return normalized === "diff" || normalized === "patch";
}

/**
 * Highlights one line. Unknown languages return a single plain token, so the
 * caller never has to branch on whether highlighting was available.
 */
export function highlightLine(line: string, language: string | null | undefined): Token[] {
  const resolved = resolveLanguage(language);
  if (!resolved) {
    return [{ text: line, kind: "plain" }];
  }

  const rules = languages[resolved];
  if (!rules) {
    return [{ text: line, kind: "plain" }];
  }

  const tokens: Token[] = [];
  let buffer = "";
  let index = 0;

  const flush = (): void => {
    if (!buffer) {
      return;
    }

    tokens.push({ text: buffer, kind: classifyWord(buffer, rules) });
    buffer = "";
  };

  while (index < line.length) {
    const rest = line.slice(index);

    const comment = rules.lineComment.find((marker) => rest.startsWith(marker));
    if (comment) {
      flush();
      tokens.push({ text: rest, kind: "comment" });
      return tokens;
    }

    if (rules.blockComment && rest.startsWith(rules.blockComment[0])) {
      flush();
      const close = rest.indexOf(rules.blockComment[1], rules.blockComment[0].length);
      const end = close === -1 ? rest.length : close + rules.blockComment[1].length;
      tokens.push({ text: rest.slice(0, end), kind: "comment" });
      index += end;
      continue;
    }

    const quote = rules.stringDelimiters.find((delimiter) => rest.startsWith(delimiter));
    if (quote) {
      flush();
      const end = findStringEnd(rest, quote);
      tokens.push({ text: rest.slice(0, end), kind: "string" });
      index += end;
      continue;
    }

    const character = line[index] ?? "";
    if (/[A-Za-z0-9_$]/.test(character)) {
      buffer += character;
      index += 1;
      continue;
    }

    flush();
    // A word directly followed by "(" reads as a call, which is the single
    // most useful non-keyword distinction in a terminal.
    if (character === "(" && tokens.length > 0) {
      const previous = tokens[tokens.length - 1];
      if (previous && previous.kind === "plain" && /^[A-Za-z_$][\w$]*$/.test(previous.text)) {
        previous.kind = "function";
      }
    }

    tokens.push({ text: character, kind: sharedPunctuation.test(character) ? "punctuation" : "plain" });
    index += 1;
  }

  flush();
  return tokens;
}

function classifyWord(word: string, rules: LanguageRules): TokenKind {
  if (rules.keywords.has(word)) {
    return "keyword";
  }

  return /^\d[\d_.]*$/.test(word) || /^0[xXbBoO][0-9a-fA-F_]+$/.test(word) ? "number" : "plain";
}

/** Handles escapes so a quote inside a string does not end it early. */
function findStringEnd(rest: string, quote: string): number {
  let index = quote.length;
  while (index < rest.length) {
    if (rest[index] === "\\") {
      index += 2;
      continue;
    }

    if (rest.startsWith(quote, index)) {
      return index + quote.length;
    }

    index += 1;
  }

  // Unterminated: a streaming block often ends mid-string.
  return rest.length;
}

function toSet(words: string): Set<string> {
  return new Set(words.split(/\s+/).filter(Boolean));
}

export type DiffLineKind = "added" | "removed" | "meta" | "hunk" | "context";

/** Classifies a diff line so it can be coloured without parsing the patch. */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
    return "meta";
  }
  if (line.startsWith("@@")) {
    return "hunk";
  }
  if (line.startsWith("+")) {
    return "added";
  }
  if (line.startsWith("-")) {
    return "removed";
  }

  return "context";
}
