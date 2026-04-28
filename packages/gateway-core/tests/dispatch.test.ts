import { describe, it, expect } from "vitest";
import {
  requestTranslators,
  translateRequest,
  type Direction,
  type Format,
} from "../src/translate/dispatch.js";
import type { AnthropicMessagesRequest } from "../src/translate/types.js";

const ALL_FORMATS: Format[] = ["anthropic", "openai-chat", "openai-responses"];

describe("dispatch table — coverage", () => {
  it("contains an entry for every (client, upstream) Format pair (3 × 3 = 9)", () => {
    for (const client of ALL_FORMATS) {
      for (const upstream of ALL_FORMATS) {
        const direction: Direction = `${client}->${upstream}`;
        expect(requestTranslators[direction]).toBeDefined();
      }
    }
  });

  it("the 3 same-format pairs are passthrough (returns body unchanged)", () => {
    const body: AnthropicMessagesRequest = {
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
    };
    expect(requestTranslators["anthropic->anthropic"](body)).toBe(body);
    expect(
      requestTranslators["openai-chat->openai-chat"]({
        model: "x",
        messages: [{ role: "user", content: "hi" }],
      } as never),
    ).toMatchObject({ model: "x" });
    expect(
      requestTranslators["openai-responses->openai-responses"]({
        model: "x",
        input: "hi",
      } as never),
    ).toMatchObject({ model: "x" });
  });
});

describe("translateRequest — dispatch helper", () => {
  it("dispatches an anthropic request to the openai-responses translator", () => {
    const out = translateRequest("anthropic", "openai-responses", {
      model: "claude-x",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 100,
    } as AnthropicMessagesRequest);
    // Output is shaped as a Responses request.
    expect(out).toMatchObject({
      model: "claude-x",
      input: [{ type: "message", role: "user", content: "ping" }],
      max_output_tokens: 100,
    });
  });

  it("dispatches a Responses request to the chat pivot via anthropic", () => {
    const out = translateRequest("openai-responses", "openai-chat", {
      model: "gpt-4o",
      input: "hello",
    });
    // Output is shaped as a Chat request.  Pivot path: responses → anth → chat.
    expect(out).toMatchObject({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("throws on an unknown direction (programming error guard)", () => {
    expect(() =>
      translateRequest(
        "anthropic" as Format,
        "garbage" as Format,
        {} as AnthropicMessagesRequest,
      ),
    ).toThrow(/unknown_translate_direction/);
  });
});
