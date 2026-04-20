import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { translateOpenAIToAnthropic } from "../src/translate/openaiToAnthropic.js";
import type { OpenAIChatRequest } from "../src/translate/types.js";

const FIXTURES_DIR = join(
  import.meta.dirname,
  "../test/fixtures/openai-requests",
);

function loadFixture<T>(name: string, suffix: string): T {
  const raw = readFileSync(
    join(FIXTURES_DIR, `${name}.${suffix}.json`),
    "utf-8",
  );
  return JSON.parse(raw) as T;
}

const FIXTURE_NAMES = [
  "plain-text-chat",
  "with-system-multi-system",
  "with-tools",
  "tool-result-roundtrip",
  "image-input",
  "tool-choice-required",
  "assistant-with-text-and-tool-calls",
] as const;

describe("translateOpenAIToAnthropic", () => {
  for (const name of FIXTURE_NAMES) {
    it(`fixture: ${name}`, () => {
      const openai = loadFixture<OpenAIChatRequest>(name, "openai");
      const expected = loadFixture<unknown>(name, "anthropic");
      const actual = translateOpenAIToAnthropic(openai);
      expect(actual).toEqual(expected);
    });
  }

  it("defaults max_tokens to 4096 when omitted", () => {
    const result = translateOpenAIToAnthropic({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(result.max_tokens).toBe(4096);
  });

  it("drops stream_options silently", () => {
    const result = translateOpenAIToAnthropic({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(result.stream).toBe(true);
    expect("stream_options" in result).toBe(false);
  });

  it("tool_choice required → { type: any }", () => {
    const result = translateOpenAIToAnthropic({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      tool_choice: "required",
    });
    expect(result.tool_choice).toEqual({ type: "any" });
  });

  it("tool_choice none → omit tool_choice field", () => {
    const result = translateOpenAIToAnthropic({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      tool_choice: "none",
    });
    expect("tool_choice" in result).toBe(false);
  });

  it("tool_choice named function → { type: tool, name }", () => {
    const result = translateOpenAIToAnthropic({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      tool_choice: { type: "function", function: { name: "my_func" } },
    });
    expect(result.tool_choice).toEqual({ type: "tool", name: "my_func" });
  });

  it("passthrough: temperature and top_p", () => {
    const result = translateOpenAIToAnthropic({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      temperature: 0.5,
      top_p: 0.9,
    });
    expect(result.temperature).toBe(0.5);
    expect(result.top_p).toBe(0.9);
  });

  it("multiple system messages are joined with newline", () => {
    const result = translateOpenAIToAnthropic({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "Instruction one." },
        { role: "system", content: "Instruction two." },
        { role: "user", content: "Question" },
      ],
    });
    expect(result.system).toBe("Instruction one.\nInstruction two.");
  });

  it("no system messages → no system field", () => {
    const result = translateOpenAIToAnthropic({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect("system" in result).toBe(false);
  });

  it("throws when tool_calls has malformed arguments JSON", () => {
    const req = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "tc_1",
              type: "function",
              function: { name: "calc", arguments: "{not valid json" },
            },
          ],
        },
      ],
      max_tokens: 1024,
    };
    expect(() => translateOpenAIToAnthropic(req as any)).toThrow(
      /Invalid tool_call\.function\.arguments/,
    );
  });

  it("base64 data URI image_url → base64 image block", () => {
    const result = translateOpenAIToAnthropic({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
            },
          ],
        },
      ],
    });
    const msg = result.messages[0];
    expect(msg).toBeDefined();
    const content = msg!.content;
    expect(Array.isArray(content)).toBe(true);
    const block = (content as unknown[])[0] as {
      type: string;
      source: { type: string; media_type: string; data: string };
    };
    expect(block.type).toBe("image");
    expect(block.source.type).toBe("base64");
    expect(block.source.media_type).toBe("image/png");
    expect(block.source.data).toBe("iVBORw0KGgo=");
  });
});
