import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicToolChoice,
  AnthropicToolDef,
} from "./types.js";
import type {
  ResponsesInputContent,
  ResponsesInputItem,
  ResponsesRequest,
  ResponsesTool,
  ResponsesToolChoice,
} from "./responsesTypes.js";

// Plan 5A §10.3 — translate an Anthropic Messages API request body into
// an OpenAI Responses API request body.  Pure function.  Used by the
// gateway when an Anthropic-format client (Claude Code) is routed to an
// OpenAI Responses upstream account.
//
// Mapping (per design §10.3):
//   - `system`            → `instructions`
//   - `messages`          → `input` (per-block transform; see below)
//   - `tools`             → `tools` (anthropic name/input_schema → fn/parameters)
//   - `tool_choice`       → `tool_choice` (anthropic 'any' → responses 'required')
//   - `max_tokens`        → `max_output_tokens`
//   - `temperature`/`top_p`/`stream` → carry through verbatim
//   - `stop_sequences`    → DROPPED (responses API has no equivalent)
//   - `metadata`          → DROPPED
//
// Anthropic content-block → Responses input-item shape conversions:
//   - text block            → message content `{ type: 'input_text', text }`
//                             on user role; `output_text` on assistant role
//   - image block (base64)  → `{ type: 'input_image', image_url: data:URI }`
//   - tool_use block        → `function_call` input item (assistant turn echo)
//   - tool_result block     → `function_call_output` input item (user turn)
//
// Errors: throw `BodyTranslationError` for unsupported feature combinations
// (e.g. an Anthropic tool block in an unexpected position).  The error code
// surfaces as HTTP 400 `unsupported_feature` per design A6.

export class BodyTranslationError extends Error {
  constructor(
    public readonly code: string,
    detail: string,
  ) {
    // Include the code in message so toThrow(/code/) assertions + log
    // grep'ing both work without parsing structured fields.
    super(`${code}: ${detail}`);
    this.name = "BodyTranslationError";
  }
}

export function translateAnthropicToResponses(
  body: AnthropicMessagesRequest,
): ResponsesRequest {
  const out: ResponsesRequest = {
    model: body.model,
    input: translateMessagesToInput(body.messages),
  };

  if (body.system !== undefined) out.instructions = body.system;
  if (body.max_tokens !== undefined) out.max_output_tokens = body.max_tokens;
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

function translateMessagesToInput(
  messages: AnthropicMessage[],
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  for (const msg of messages) {
    items.push(...translateMessage(msg));
  }
  return items;
}

function translateMessage(msg: AnthropicMessage): ResponsesInputItem[] {
  // Plain-string content is the simple case — emit one message item.
  if (typeof msg.content === "string") {
    return [
      {
        type: "message",
        role: msg.role,
        content: msg.content,
      },
    ];
  }

  // Block content needs to be split by type:
  //   - text/image blocks belong inside a message item's `content` array
  //   - tool_use blocks become standalone `function_call` items
  //   - tool_result blocks become standalone `function_call_output` items
  const items: ResponsesInputItem[] = [];
  const messageContent: ResponsesInputContent[] = [];

  for (const block of msg.content) {
    const item = translateBlock(block, msg.role);
    if (item.kind === "content") {
      messageContent.push(item.content);
    } else {
      // Flush any pending message content before emitting the standalone
      // item so ordering is preserved across mixed-block messages.
      if (messageContent.length > 0) {
        items.push({
          type: "message",
          role: msg.role,
          content: messageContent.splice(0),
        });
      }
      items.push(item.item);
    }
  }

  if (messageContent.length > 0) {
    items.push({
      type: "message",
      role: msg.role,
      content: messageContent,
    });
  }

  return items;
}

type BlockTranslation =
  | { kind: "content"; content: ResponsesInputContent }
  | { kind: "item"; item: ResponsesInputItem };

function translateBlock(
  block: AnthropicContentBlock,
  role: AnthropicMessage["role"],
): BlockTranslation {
  switch (block.type) {
    case "text":
      return {
        kind: "content",
        content: {
          type: role === "assistant" ? "output_text" : "input_text",
          text: block.text,
        },
      };
    case "image": {
      // Anthropic uses `source.type='base64'` with a media_type + data;
      // Responses uses a data URI in `image_url`.  URL sources pass
      // through directly.
      const src = block.source;
      const url =
        src.type === "base64"
          ? `data:${src.media_type};base64,${src.data}`
          : src.url;
      return {
        kind: "content",
        content: { type: "input_image", image_url: url },
      };
    }
    case "tool_use":
      return {
        kind: "item",
        item: {
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      };
    case "tool_result": {
      // Tool results may carry text blocks; concatenate them into a
      // single `output` string per Responses API shape.
      const output =
        typeof block.content === "string"
          ? block.content
          : block.content.map((c) => c.text).join("");
      return {
        kind: "item",
        item: {
          type: "function_call_output",
          call_id: block.tool_use_id,
          output,
        },
      };
    }
  }
}

function translateTool(tool: AnthropicToolDef): ResponsesTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  };
}

function translateToolChoice(choice: AnthropicToolChoice): ResponsesToolChoice {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      // Anthropic `any` ≈ Responses `required` — model MUST call a tool.
      return "required";
    case "tool":
      return { type: "function", name: choice.name };
  }
}
