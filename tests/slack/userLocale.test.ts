import { describe, expect, it } from "vite-plus/test";

import { resolveSlackUserLocale } from "../../src/slack/userLocale.js";

describe("resolveSlackUserLocale", () => {
  it("uses the Slack user locale when supported", async () => {
    await expect(
      resolveSlackUserLocale({
        client: { users: { info: async () => ({ user: { locale: "en-US" } }) } },
        defaultLocale: "ja",
        logger: { warn() {} },
        userId: "U1",
      }),
    ).resolves.toBe("en");
  });

  it("falls back to the configured default locale when Slack lookup fails", async () => {
    await expect(
      resolveSlackUserLocale({
        client: {
          users: {
            info: async () => {
              throw new Error("slack unavailable");
            },
          },
        },
        defaultLocale: "ja",
        logger: { warn() {} },
        userId: "U1",
      }),
    ).resolves.toBe("ja");
  });
});
