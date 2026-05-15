import { describe, expect, it } from "vite-plus/test";

import { createTranslator, normalizeLocale, resolveLocale } from "../../src/i18n/index.js";

describe("i18n locale handling", () => {
  it("normalizes supported Slack locale variants", () => {
    expect(normalizeLocale("ja-JP")).toBe("ja");
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("en_GB")).toBe("en");
    expect(normalizeLocale("fr-FR")).toBeUndefined();
  });

  it("falls back when the locale is missing or unsupported", () => {
    expect(resolveLocale(undefined, "ja")).toBe("ja");
    expect(resolveLocale("fr-FR", "en")).toBe("en");
  });

  it("translates configured messages with interpolation", () => {
    expect(
      createTranslator("en").t("rss.parent", { feedUrl: "https://example.com/feed.xml" }),
    ).toBe("RSS updates: https://example.com/feed.xml");
    expect(
      createTranslator("ja").t("rss.parent", { feedUrl: "https://example.com/feed.xml" }),
    ).toBe("RSS更新: https://example.com/feed.xml");
  });
});
