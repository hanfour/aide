import { describe, it, expect } from "vitest";
import {
  responseTranslators,
  translateResponse,
  type Direction,
  type Format,
} from "../../src/translate/dispatch.js";
import type {
  AnthropicMessagesResponse,
  OpenAIChatCompletionResponse,
} from "../../src/translate/types.js";
import type { ResponsesResponse } from "../../src/translate/responsesTypes.js";

const ALL_FORMATS: Format[] = ["anthropic", "openai-chat", "openai-responses"];

const NOW = () => 1700000000_000;

const sampleAnthropic: AnthropicMessagesResponse = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "hi" }],
  model: "claude-3-5-sonnet-20241022",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 1 },
};

const sampleChat: OpenAIChatCompletionResponse = {
  id: "chatcmpl_1",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4-turbo",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "hi" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
};

const sampleResponses: ResponsesResponse = {
  id: "resp_1",
  object: "response",
  created_at: 1700000000,
  model: "gpt-4o",
  status: "completed",
  output: [
    {
      type: "message",
      id: "m",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "hi", annotations: [] }],
    },
  ],
  usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
  incomplete_details: null,
};

describe("response dispatch table — coverage", () => {
  it("contains an entry for every 9 Format pairs", () => {
    for (const client of ALL_FORMATS) {
      for (const upstream of ALL_FORMATS) {
        const direction: Direction = `${client}->${upstream}`;
        expect(responseTranslators[direction]).toBeDefined();
      }
    }
  });

  it("the 3 same-format pairs are passthrough (return body unchanged)", () => {
    expect(responseTranslators["anthropic->anthropic"](sampleAnthropic)).toBe(
      sampleAnthropic,
    );
    expect(responseTranslators["openai-chat->openai-chat"](sampleChat)).toBe(
      sampleChat,
    );
    expect(
      responseTranslators["openai-responses->openai-responses"](sampleResponses),
    ).toBe(sampleResponses);
  });
});

describe("translateResponse", () => {
  it("dispatches anthropic->openai-chat (upstream Chat → client Anthropic)", () => {
    const out = translateResponse(
      "anthropic",
      "openai-chat",
      sampleChat,
    ) as AnthropicMessagesResponse;
    expect(out.type).toBe("message");
    expect(out.content[0]).toMatchObject({ type: "text", text: "hi" });
  });

  it("dispatches openai-chat->anthropic (upstream Anthropic → client Chat)", () => {
    const out = translateResponse(
      "openai-chat",
      "anthropic",
      sampleAnthropic,
      { now: NOW },
    ) as OpenAIChatCompletionResponse;
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0]!.message.content).toBe("hi");
  });

  it("dispatches openai-responses->anthropic (upstream Anthropic → client Responses)", () => {
    const out = translateResponse(
      "openai-responses",
      "anthropic",
      sampleAnthropic,
      { now: NOW },
    ) as ResponsesResponse;
    expect(out.object).toBe("response");
    expect(out.status).toBe("completed");
  });

  it("dispatches anthropic->openai-responses (upstream Responses → client Anthropic)", () => {
    const out = translateResponse(
      "anthropic",
      "openai-responses",
      sampleResponses,
    ) as AnthropicMessagesResponse;
    expect(out.type).toBe("message");
    expect(out.stop_reason).toBe("end_turn");
  });

  it("pivot openai-chat->openai-responses (upstream Responses → client Chat)", () => {
    const out = translateResponse(
      "openai-chat",
      "openai-responses",
      sampleResponses,
      { now: NOW },
    ) as OpenAIChatCompletionResponse;
    expect(out.object).toBe("chat.completion");
  });

  it("pivot openai-responses->openai-chat (upstream Chat → client Responses)", () => {
    const out = translateResponse(
      "openai-responses",
      "openai-chat",
      sampleChat,
      { now: NOW },
    ) as ResponsesResponse;
    expect(out.object).toBe("response");
  });

  it("passthrough anthropic->anthropic returns body identity", () => {
    const out = translateResponse(
      "anthropic",
      "anthropic",
      sampleAnthropic,
    );
    expect(out).toBe(sampleAnthropic);
  });
});
