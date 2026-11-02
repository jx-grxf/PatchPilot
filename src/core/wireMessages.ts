import type { ChatMessage } from "./types.js";

/**
 * History goes to the runtime in the exact shape the model's chat template was
 * trained on. Flattening past calls into text teaches the model, from its own
 * history, to write calls as prose instead of making them.
 */
export function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) }
        }))
      };
    }
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    }
    return { role: message.role, content: message.content };
  });
}

/** Ollama takes arguments as an object and matches results by tool name. */
export function toOllamaMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments } }))
      };
    }
    if (message.role === "tool") {
      return { role: "tool", tool_name: message.toolName, content: message.content };
    }
    return { role: message.role, content: message.content };
  });
}
