export type LocalConversationResult =
  | {
      handled: true;
      tone: "accent" | "warning";
      message: string;
    }
  | {
      handled: false;
    };

export function routeLocalConversation(task: string): LocalConversationResult {
  const normalizedTask = task.trim().toLowerCase();
  const plainTask = normalizedTask.replace(/[!?.\s]/g, "");

  if (["hi", "hey", "hello", "hallo", "servus", "yo", "moin"].includes(plainTask)) {
    return {
      handled: true,
      tone: "accent",
      message: "Hey. Sag mir, was ich im aktuellen Projekt bauen, fixen, testen oder erklären soll."
    };
  }

  if (["ok", "okay", "nice", "cool", "danke", "thanks", "thx"].includes(plainTask)) {
    return {
      handled: true,
      tone: "accent",
      message: "Passt. Gib mir einfach den nächsten konkreten Coding-Task."
    };
  }

  if (task.trim().split(/\s+/).length <= 2 && !looksLikeCodingTask(normalizedTask)) {
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
