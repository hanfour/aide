import type {
  OpenAIChatRequest,
  OpenAIChatMessage,
  OpenAIContentPart,
  OpenAIToolCall,
  AnthropicMessagesRequest,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicImageBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicToolDef,
  AnthropicToolChoice,
} from "./types.js";

const DEFAULT_MAX_TOKENS = 4096;

/**
 * Translate an OpenAI chat/completions request body into the Anthropic
 * messages API shape. Pure function — no side effects.
 */
export function translateOpenAIToAnthropic(
  req: OpenAIChatRequest,
): AnthropicMessagesRequest {
  const systemText = extractSystemText(req.messages);
  const messages = translateMessages(req.messages);
  const tools = req.tools !== undefined ? translateTools(req.tools) : undefined;
  const tool_choice = translateToolChoice(req.tool_choice);

  const result: AnthropicMessagesRequest = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
  };

  if (systemText !== undefined) {
    result.system = systemText;
  }

  if (tools !== undefined) {
    result.tools = tools;
  }

  if (tool_choice !== undefined) {
    result.tool_choice = tool_choice;
  }

  if (req.temperature !== undefined) {
    result.temperature = req.temperature;
  }

  if (req.top_p !== undefined) {
    result.top_p = req.top_p;
  }

  if (req.stream !== undefined) {
    result.stream = req.stream;
  }

  // stream_options is silently dropped per spec

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSystemText(messages: OpenAIChatMessage[]): string | undefined {
  const systemContents = messages
    .filter((m) => m.role === "system")
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("");
      }
      return "";
    });

  if (systemContents.length === 0) return undefined;
  return systemContents.join("\n");
}

function translateMessages(messages: OpenAIChatMessage[]): AnthropicMessage[] {
  const nonSystem = messages.filter((m) => m.role !== "system");
  return nonSystem.map(translateMessage);
}

function translateMessage(msg: OpenAIChatMessage): AnthropicMessage {
  if (msg.role === "tool") {
    // tool result → user message with tool_result block
    const block: AnthropicToolResultBlock = {
      type: "tool_result",
      tool_use_id: msg.tool_call_id ?? "",
      content: typeof msg.content === "string" ? msg.content : "",
    };
    return { role: "user", content: [block] };
  }

  if (
    msg.role === "assistant" &&
    msg.tool_calls !== undefined &&
    msg.tool_calls.length > 0
  ) {
    // assistant message with tool calls — emit text blocks first, then tool_use blocks
    const blocks: Array<AnthropicTextBlock | AnthropicToolUseBlock> = [];
    if (typeof msg.content === "string" && msg.content.length > 0) {
      blocks.push({ type: "text", text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && part.text) {
          blocks.push({ type: "text", text: part.text });
        }
      }
    }
    for (const tc of msg.tool_calls) {
      blocks.push(translateToolCall(tc));
    }
    return { role: "assistant", content: blocks };
  }

  if (msg.role === "assistant") {
    const content = msg.content ?? "";
    return {
      role: "assistant",
      content:
        typeof content === "string" ? content : translateContentParts(content),
    };
  }

  // user message
  if (typeof msg.content === "string") {
    return { role: "user", content: msg.content };
  }

  if (Array.isArray(msg.content)) {
    return { role: "user", content: translateContentParts(msg.content) };
  }

  return { role: "user", content: "" };
}

function translateContentParts(
  parts: OpenAIContentPart[],
): AnthropicContentBlock[] {
  return parts.map(translateContentPart);
}

function translateContentPart(
  part: OpenAIContentPart,
): AnthropicTextBlock | AnthropicImageBlock {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }

  // image_url part
  const url = part.image_url.url;

  if (url.startsWith("data:")) {
    return translateBase64ImageURL(url);
  }

  // External URL → Anthropic URL source
  const imageBlock: AnthropicImageBlock = {
    type: "image",
    source: { type: "url", url },
  };
  return imageBlock;
}

function translateBase64ImageURL(dataURI: string): AnthropicImageBlock {
  // Format: data:<mediaType>;base64,<data>
  const withoutScheme = dataURI.slice("data:".length);
  const semicolonIdx = withoutScheme.indexOf(";");
  const rawMediaType = withoutScheme.slice(0, semicolonIdx);
  const rest = withoutScheme.slice(semicolonIdx + 1); // "base64,<data>"
  const commaIdx = rest.indexOf(",");
  const data = rest.slice(commaIdx + 1);

  const mediaType = normalizeMediaType(rawMediaType);

  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data },
  };
}

function normalizeMediaType(
  raw: string,
): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  const lower = raw.toLowerCase();
  if (lower === "image/jpeg" || lower === "image/jpg") return "image/jpeg";
  if (lower === "image/gif") return "image/gif";
  if (lower === "image/webp") return "image/webp";
  return "image/png"; // default for unknown
}

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("tool_call.function.arguments must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid tool_call.function.arguments JSON: ${msg}`);
  }
}

function translateToolCall(tc: OpenAIToolCall): AnthropicToolUseBlock {
  return {
    type: "tool_use",
    id: tc.id,
    name: tc.function.name,
    input: parseToolArgs(tc.function.arguments),
  };
}

function translateTools(
  tools: OpenAIChatRequest["tools"],
): AnthropicToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => {
    const def: AnthropicToolDef = {
      name: t.function.name,
      input_schema: (t.function.parameters as Record<string, unknown>) ?? {},
    };
    if (t.function.description !== undefined) {
      def.description = t.function.description;
    }
    return def;
  });
}

function translateToolChoice(
  choice: OpenAIChatRequest["tool_choice"],
): AnthropicToolChoice | undefined {
  if (choice === undefined || choice === "none") return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (typeof choice === "object" && choice.type === "function") {
    return { type: "tool", name: choice.function.name };
  }
  return undefined;
}
