import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTextBlock,
  AnthropicToolChoice,
  AnthropicToolDef,
} from "./types.js";
import { BodyTranslationError } from "./anthropicToResponses.js";
import type {
  ResponsesInputContent,
  ResponsesInputItem,
  ResponsesInputMessage,
  ResponsesRequest,
  ResponsesTool,
  ResponsesToolChoice,
} from "./responsesTypes.js";

// Plan 5A §10.3 — translate an OpenAI Responses API request body into an
// Anthropic Messages API request body.  Pure function.  Used by the
// gateway when a Responses-format client (Codex CLI) is routed to an
// Anthropic upstream account.
//
// Mapping (inverse of anthropicToResponses):
//   - `instructions`         → `system`
//   - `input` (string)       → single user message with that string
//   - `input` (item array)   → message folding (consecutive `message` items
//                              keep their role; `function_call` becomes a
//                              tool_use block on assistant; `function_call_output`
//                              becomes a tool_result block on user)
//   - `tools`                → `tools`
//   - `tool_choice` 'required' → `{ type: 'any' }`; 'function:name' → `{ type:'tool', name }`
//   - `max_output_tokens`    → `max_tokens`
//   - `temperature`/`top_p`/`stream` → carry through
//
// Rejected (per design A6 / §9.4):
//   - `previous_response_id` is allowed by the schema (sticky scheduling
//     uses it) but the field has no Anthropic counterpart and is dropped
//     here.  The route handler is the layer that observes it for the
//     scheduler before invoking translation.
//   - `store=true` (we don't observe it; gateway never persists upstream)

const DEFAULT_MAX_TOKENS = 4096;

export function translateResponsesToAnthropic(
  body: ResponsesRequest,
): AnthropicMessagesRequest {
  const out: AnthropicMessagesRequest = {
    model: body.model,
    messages: translateInputToMessages(body.input),
    max_tokens: body.max_output_tokens ?? DEFAULT_MAX_TOKENS,
  };

  if (body.instructions !== undefined) out.system = body.instructions;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stream !== undefined) out.stream = body.stream;
  if (body.tools && body.tools.length > 0) {
    out.tools = body.tools.map(translateTool);
  }
  if (body.tool_choice !== undefined) {
    out.tool_choice = translateToolChoice(body.tool_choice);
  }

  return out;
}

function translateInputToMessages(
  input: ResponsesRequest["input"],
): AnthropicMessage[] {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  // Fold the heterogeneous input-item stream back into Anthropic
  // messages.  Strategy: walk forward, keep an "open" message we're
  // accumulating into, flush whenever the role changes or we hit a
  // function-call/function-call-output that needs to attach to a
  // specific role.
  const messages: AnthropicMessage[] = [];
  let openRole: AnthropicMessage["role"] | null = null;
  let openBlocks: AnthropicContentBlock[] = [];

  const flush = () => {
    if (openRole !== null && openBlocks.length > 0) {
      messages.push({ role: openRole, content: openBlocks });
    }
    openRole = null;
    openBlocks = [];
  };

  for (const item of input) {
    if ("type" in item && item.type === "function_call") {
      // Assistant turn — emit alongside any pending assistant text.
      const block: AnthropicContentBlock = {
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        input: parseFunctionArguments(item.arguments),
      };
      if (openRole !== "assistant") flush();
      openRole = "assistant";
      openBlocks.push(block);
      continue;
    }

    if ("type" in item && item.type === "function_call_output") {
      // User turn — submitting a tool result back to the model.
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: item.call_id,
        content: item.output,
      };
      if (openRole !== "user") flush();
      openRole = "user";
      openBlocks.push(block);
      continue;
    }

    // Otherwise it's a `message` (the discriminator may be implicit on
    // older clients — fall through to treat as message).
    const msg = item as ResponsesInputMessage;
    if (msg.role === "system") {
      // Per design — Responses-format `system`-role input items at the
      // top of `input` are an alternative to `instructions`.  Anthropic's
      // shape doesn't support per-message system; we lift to `system`
      // (or merge into existing) at the request level instead.
      throw new BodyTranslationError(
        "responses_input_system_role_unsupported",
        "system-role messages in `input` are not supported; pass `instructions` at the request level instead",
      );
    }

    const role: AnthropicMessage["role"] = msg.role;
    if (openRole !== role) flush();
    openRole = role;
    appendMessageContent(openBlocks, msg.content);
  }

  flush();
  return messages;
}

function appendMessageContent(
  blocks: AnthropicContentBlock[],
  content: string | ResponsesInputContent[],
): void {
  if (typeof content === "string") {
    blocks.push({ type: "text", text: content });
    return;
  }
  for (const part of content) {
    if (part.type === "input_text" || part.type === "output_text") {
      blocks.push({ type: "text", text: part.text } satisfies AnthropicTextBlock);
    } else if (part.type === "input_image") {
      blocks.push(translateImageURLToAnthropic(part.image_url));
    }
  }
}

function translateImageURLToAnthropic(url: string): AnthropicImageBlock {
  // Data URIs map back to base64 source; http(s) URLs map to URL source.
  if (url.startsWith("data:")) {
    const match = /^data:([^;]+);base64,(.+)$/.exec(url);
    if (!match) {
      throw new BodyTranslationError(
        "responses_image_url_invalid_data_uri",
        `image_url is not a recognised base64 data URI`,
      );
    }
    const mediaType = match[1] as
      | "image/jpeg"
      | "image/png"
      | "image/gif"
      | "image/webp";
    return {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: match[2]! },
    };
  }
  return { type: "image", source: { type: "url", url } };
}

function parseFunctionArguments(raw: string): Record<string, unknown> {
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BodyTranslationError(
      "responses_function_call_arguments_invalid_json",
      `function_call.arguments is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BodyTranslationError(
      "responses_function_call_arguments_not_object",
      "function_call.arguments must JSON-decode to an object",
    );
  }
  return parsed as Record<string, unknown>;
}

function translateTool(tool: ResponsesTool): AnthropicToolDef {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

function translateToolChoice(
  choice: ResponsesToolChoice,
): AnthropicToolChoice {
  if (choice === "auto" || choice === "none") {
    // Anthropic doesn't have an explicit 'none' — use 'auto' and the
    // request will simply not invoke a tool unless the model decides to.
    return { type: "auto" };
  }
  if (choice === "required") {
    return { type: "any" };
  }
  return { type: "tool", name: choice.name };
}
