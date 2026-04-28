import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicToolChoice,
  AnthropicToolDef,
  OpenAIChatMessage,
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAITool,
  OpenAIToolChoice,
} from "./types.js";
import { BodyTranslationError } from "./anthropicToResponses.js";

// Plan 5A — translate an Anthropic Messages REQUEST into an OpenAI Chat
// Completions REQUEST.  Pure function.  Used when an Anthropic-format
// client (Claude Code) is routed to a chat-format upstream account, OR
// as the second leg of the responses → chat pivot.
//
// 4A already had `openaiToAnthropic.ts` (chat → anthropic request) +
// `anthropicToOpenai.ts` (anthropic → chat RESPONSE).  This file is the
// missing fourth quadrant — anthropic → chat REQUEST — needed for full
// 5A coverage of the dispatch matrix (design §10.7).

export function translateAnthropicToChat(
  body: AnthropicMessagesRequest,
): OpenAIChatRequest {
  const messages: OpenAIChatMessage[] = [];
  if (body.system !== undefined && body.system.length > 0) {
    messages.push({ role: "system", content: body.system });
  }
  for (const msg of body.messages) {
    messages.push(...translateMessage(msg));
  }

  const out: OpenAIChatRequest = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
  };
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

function translateMessage(msg: AnthropicMessage): OpenAIChatMessage[] {
  if (typeof msg.content === "string") {
    return [{ role: msg.role, content: msg.content }];
  }

  // Block content needs to fan out:
  //   - text/image blocks become a single chat message with an array of
  //     content parts (or string when text-only)
  //   - tool_use blocks ride along on assistant messages via tool_calls
  //   - tool_result blocks become standalone `tool` role messages (one
  //     per result, since chat's tool messages are per-tool_call_id)
  const parts: OpenAIContentPart[] = [];
  const toolCalls: NonNullable<OpenAIChatMessage["tool_calls"]> = [];
  const toolResults: OpenAIChatMessage[] = [];

  for (const block of msg.content) {
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: block.text });
        break;
      case "image": {
        const src = block.source;
        const url =
          src.type === "base64"
            ? `data:${src.media_type};base64,${src.data}`
            : src.url;
        parts.push({ type: "image_url", image_url: { url } });
        break;
      }
      case "tool_use":
        if (msg.role !== "assistant") {
          throw new BodyTranslationError(
            "anthropic_tool_use_non_assistant",
            "tool_use blocks are only valid on assistant messages",
          );
        }
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
        break;
      case "tool_result": {
        if (msg.role !== "user") {
          throw new BodyTranslationError(
            "anthropic_tool_result_non_user",
            "tool_result blocks are only valid on user messages",
          );
        }
        const resultText =
          typeof block.content === "string"
            ? block.content
            : block.content.map((c) => c.text).join("");
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: resultText,
        });
        break;
      }
    }
  }

  const out: OpenAIChatMessage[] = [];
  // Chat semantics: the assistant turn that calls a tool may also have
  // text content alongside `tool_calls`.  User turns with tool results
  // are split into one tool-role message per result; any user-side
  // text/image parts ride a separate user message before the results.
  if (msg.role === "assistant") {
    if (parts.length > 0 || toolCalls.length > 0) {
      out.push({
        role: "assistant",
        content: textOnlyOrParts(parts),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
  } else {
    if (parts.length > 0) {
      out.push({ role: "user", content: textOnlyOrParts(parts) });
    }
    out.push(...toolResults);
  }

  return out;
}

/**
 * Collapse a `[ { type: 'text', text } ]` single-element parts array to
 * the plain string form when possible — chat clients commonly expect
 * that shape and the array form is only required when an image is
 * present or there are multiple text segments.
 */
function textOnlyOrParts(
  parts: OpenAIContentPart[],
): string | OpenAIContentPart[] {
  if (parts.length === 0) return "";
  if (parts.length === 1 && parts[0]!.type === "text") {
    return parts[0]!.text;
  }
  return parts;
}

function translateTool(tool: AnthropicToolDef): OpenAITool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

function translateToolChoice(choice: AnthropicToolChoice): OpenAIToolChoice {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return { type: "function", function: { name: choice.name } };
  }
}

// We intentionally use AnthropicContentBlock from the import set so the
// switch exhaustiveness check in translateMessage compiles cleanly.
type _UseAll = AnthropicContentBlock;
