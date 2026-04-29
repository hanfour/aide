import { translateResponsesToAnthropic } from "./responsesToAnthropic.js";
import { translateAnthropicToChat } from "./anthropicToChat.js";
import type { ResponsesRequest } from "./responsesTypes.js";
import type { OpenAIChatRequest } from "./types.js";

// Plan 5A §10.6 — pivot composition.  Responses → Anthropic → Chat.
// Used when a Responses-format client (Codex CLI) is routed to a
// chat-format upstream account.  Both legs are pure functions; the
// pivot adds < 1ms and keeps the translator surface to 5 modules
// instead of 8.

export function translateResponsesToChat(
  body: ResponsesRequest,
): OpenAIChatRequest {
  return translateAnthropicToChat(translateResponsesToAnthropic(body));
}
