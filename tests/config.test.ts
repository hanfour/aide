import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getDefaultConfig,
  loadConfig,
  saveConfig,
  setConfigValue,
  resetConfig,
  getConfigPath,
} from "../src/config.js";
import type { AppConfig } from "../src/config.js";

// Use a temp file for tests to avoid touching real config
const TEST_CONFIG_PATH = join(tmpdir(), `.aide-test-${process.pid}.json`);

function cleanup() {
  if (existsSync(TEST_CONFIG_PATH)) {
    unlinkSync(TEST_CONFIG_PATH);
  }
}

describe("config", () => {
  describe("getDefaultConfig", () => {
    it("returns all expected keys", () => {
      const config = getDefaultConfig();
      expect(config).toHaveProperty("locale", "en");
      expect(config).toHaveProperty("theme", "default");
      expect(config).toHaveProperty("defaultFormat", "text");
      expect(config).toHaveProperty("defaultPeriodDays", 30);
      expect(config).toHaveProperty("claudeDir");
      expect(config).toHaveProperty("codexDir");
    });

    it("returns a new object each time (immutable)", () => {
      const a = getDefaultConfig();
      const b = getDefaultConfig();
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
    });
  });

  describe("getConfigPath", () => {
    it("returns a path ending with .aide.json", () => {
      const path = getConfigPath();
      expect(path).toMatch(/\.aide\.json$/);
    });
  });

  describe("setConfigValue", () => {
    it("sets locale to zh-TW", () => {
      const config = getDefaultConfig();
      const updated = setConfigValue(config, "locale", "zh-TW");
      expect(updated.locale).toBe("zh-TW");
      // Original unchanged
      expect(config.locale).toBe("en");
    });

    it("sets theme to no-color", () => {
      const config = getDefaultConfig();
      const updated = setConfigValue(config, "theme", "no-color");
      expect(updated.theme).toBe("no-color");
    });

    it("sets defaultFormat to markdown", () => {
      const config = getDefaultConfig();
      const updated = setConfigValue(config, "defaultFormat", "markdown");
      expect(updated.defaultFormat).toBe("markdown");
    });

    it("sets defaultPeriodDays to a positive integer", () => {
      const config = getDefaultConfig();
      const updated = setConfigValue(config, "defaultPeriodDays", "14");
      expect(updated.defaultPeriodDays).toBe(14);
    });

    it("sets claudeDir to a custom path", () => {
      const config = getDefaultConfig();
      const updated = setConfigValue(config, "claudeDir", "/tmp/claude");
      expect(updated.claudeDir).toBe("/tmp/claude");
    });

    it("rejects unknown keys", () => {
      const config = getDefaultConfig();
      expect(() => setConfigValue(config, "badKey", "x")).toThrow(
        "Unknown config key",
      );
    });

    it("rejects invalid locale", () => {
      const config = getDefaultConfig();
      expect(() => setConfigValue(config, "locale", "fr")).toThrow(
        "Invalid locale",
      );
    });

    it("rejects invalid theme", () => {
      const config = getDefaultConfig();
      expect(() => setConfigValue(config, "theme", "dark")).toThrow(
        "Invalid theme",
      );
    });

    it("rejects invalid defaultFormat", () => {
      const config = getDefaultConfig();
      expect(() => setConfigValue(config, "defaultFormat", "csv")).toThrow(
        "Invalid defaultFormat",
      );
    });

    it("rejects non-positive defaultPeriodDays", () => {
      const config = getDefaultConfig();
      expect(() => setConfigValue(config, "defaultPeriodDays", "0")).toThrow(
        "positive integer",
      );
      expect(() => setConfigValue(config, "defaultPeriodDays", "abc")).toThrow(
        "positive integer",
      );
    });

    it("rejects empty claudeDir", () => {
      const config = getDefaultConfig();
      expect(() => setConfigValue(config, "claudeDir", "  ")).toThrow(
        "must not be empty",
      );
    });
  });
});
