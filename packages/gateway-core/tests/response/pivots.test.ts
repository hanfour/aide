import { describe, it, expect } from "vitest";
import { translateChatResponseToResponses } from "../../src/translate/response/chatToResponses.js";
import { translateResponsesResponseToChat } from "../../src/translate/response/responsesToChat.js";
import type { OpenAIChatCompletionResponse } from "../../src/translate/types.js";
import type { ResponsesResponse } from "../../src/translate/responsesTypes.js";

const NOW = () => 1700000000_000;

describe("translateChatResponseToResponses (pivot)", () => {
  it("plain text Chat resp → message output_item Responses resp", () => {
    const chat: OpenAIChatCompletionResponse = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4-turbo",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello world" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };
    const result = translateChatResponseToResponses(chat, { now: NOW });
    expect(result.object).toBe("response");
    expect(result.status).toBe("completed");
    expect(result.output).toHaveLength(1);
    const msg = result.output[0]!;
    if (msg.type === "message") {
      expect(msg.content[0]!.text).toBe("hello world");
    }
  });

  it("tool_calls Chat resp → function_call output_item", () => {
    const chat: OpenAIChatCompletionResponse = {
      id: "chatcmpl-tc",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4-turbo",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: '{"id":"x"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };
    const result = translateChatResponseToResponses(chat, { now: NOW });
    expect(result.output.some((i) => i.type === "function_call")).toBe(true);
  });

  it("finish_reason length → status=incomplete + max_output_tokens", () => {
    const chat: OpenAIChatCompletionResponse = {
      id: "chatcmpl-len",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4-turbo",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "..." },
          finish_reason: "length",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const result = translateChatResponseToResponses(chat, { now: NOW });
    expect(result.status).toBe("incomplete");
    expect(result.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });
});

describe("translateResponsesResponseToChat (pivot)", () => {
  it("message output_item → Chat content string", () => {
    const resp: ResponsesResponse = {
      id: "resp_1",
      object: "response",
      created_at: 1700000000,
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_x",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "hi", annotations: [] }],
        },
      ],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      incomplete_details: null,
    };
    const result = translateResponsesResponseToChat(resp, { now: NOW });
    expect(result.object).toBe("chat.completion");
    expect(result.choices[0]!.message.content).toBe("hi");
    expect(result.choices[0]!.finish_reason).toBe("stop");
  });

  it("function_call → tool_calls + finish_reason tool_calls", () => {
    const resp: ResponsesResponse = {
      id: "resp_tc",
      object: "response",
      created_at: 1700000000,
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "fc_1",
          name: "lookup",
          arguments: '{"id":"y"}',
          status: "completed",
        },
      ],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      incomplete_details: null,
    };
    const result = translateResponsesResponseToChat(resp, { now: NOW });
    expect(result.choices[0]!.finish_reason).toBe("tool_calls");
    expect(result.choices[0]!.message.tool_calls).toEqual([
      {
        id: "fc_1",
        type: "function",
        function: { name: "lookup", arguments: '{"id":"y"}' },
      },
    ]);
  });

  it("incomplete max_output_tokens → finish_reason length (round-trip)", () => {
    const resp: ResponsesResponse = {
      id: "resp_max",
      object: "response",
      created_at: 1700000000,
      model: "gpt-4o",
      status: "incomplete",
      output: [
        {
          type: "message",
          id: "m",
          role: "assistant",
          status: "incomplete",
          content: [{ type: "output_text", text: "...", annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      incomplete_details: { reason: "max_output_tokens" },
    };
    const result = translateResponsesResponseToChat(resp, { now: NOW });
    expect(result.choices[0]!.finish_reason).toBe("length");
  });
});

describe("pivot round-trip semantics", () => {
  it("Chat → Responses → Chat preserves text + finish_reason", () => {
    const chat: OpenAIChatCompletionResponse = {
      id: "chatcmpl-rt",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4-turbo",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "round-trip text" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };
    const responses = translateChatResponseToResponses(chat, { now: NOW });
    const back = translateResponsesResponseToChat(responses, { now: NOW });
    expect(back.choices[0]!.message.content).toBe("round-trip text");
    expect(back.choices[0]!.finish_reason).toBe("stop");
  });
});
