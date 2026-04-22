export type LocalConversationResult =
  | {
      handled: true;
      tone: "accent" | "warning";
      message: string;
    }
  | {
      handled: false;
    };

export function routeLocalConversation(task: string, now = new Date()): LocalConversationResult {
  const normalizedTask = task.trim().toLowerCase();
  const plainTask = normalizedTask.replace(/[!?.\s]/g, "");

  if (["hi", "hey", "hello", "hallo", "servus", "yo", "moin"].includes(plainTask)) {
    return {
      handled: true,
      tone: "accent",
      message: "Bereit. Sag kurz, welches Projektziel ich anfassen soll."
    };
  }

  if (asksForCurrentTime(normalizedTask)) {
    return {
      handled: true,
      tone: "accent",
      message: `Es ist ${formatLocalTime(now)}.`
    };
  }

  if (asksHowAreYou(normalizedTask)) {
    return {
      handled: true,
      tone: "accent",
      message: "Läuft. Ich bin bereit für den nächsten PatchPilot-Task."
    };
  }

  if (["ok", "okay", "nice", "cool", "danke", "thanks", "thx"].includes(plainTask)) {
    return {
      handled: true,
      tone: "accent",
      message: "Passt."
    };
  }

  const wordCount = task.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount === 1 && looksLikeAmbiguousCodingVerb(plainTask)) {
    return {
      handled: true,
      tone: "warning",
      message: "Was genau soll ich damit machen? Beispiel: `summarize this repository` oder `summarize README.md`."
    };
  }

  if (wordCount <= 2 && !looksLikeCodingTask(normalizedTask)) {
    return {
      handled: true,
      tone: "warning",
      message: "Zu wenig Kontext für den Agenten. Beispiel: `summarize this repository`, `run tests`, oder `add a diff preview`."
    };
  }

  return {
    handled: false
  };
}

function looksLikeCodingTask(value: string): boolean {
  return /\b(add|build|fix|test|run|read|summarize|explain|refactor|implement|create|update|debug|commit|status|diff|search|find|install|rename|remove|write|edit)\b/.test(
    value
  );
}

function looksLikeAmbiguousCodingVerb(value: string): boolean {
  return [
    "add",
    "build",
    "fix",
    "test",
    "run",
    "read",
    "summarize",
    "explain",
    "refactor",
    "implement",
    "create",
    "update",
    "debug",
    "commit",
    "diff",
    "search",
    "find",
    "install",
    "rename",
    "remove",
    "write",
    "edit"
  ].includes(value);
}

function asksForCurrentTime(value: string): boolean {
  return /\b(wie spät|uhrzeit|welche uhrzeit|what time|current time|time is it)\b/.test(value);
}

function asksHowAreYou(value: string): boolean {
  return /\b(wie gehts|wie geht es dir|how are you)\b/.test(value);
}

function formatLocalTime(value: Date): string {
  return new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  }).format(value);
}
