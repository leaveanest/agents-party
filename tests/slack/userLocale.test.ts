import { describe, expect, it } from "vite-plus/test";

import { resolveUserSettingsLocale } from "../../src/slack/userLocale.js";

describe("resolveUserSettingsLocale", () => {
  it("uses the stored user locale when supported", async () => {
    await expect(
      resolveUserSettingsLocale({
        defaultLocale: "ja",
        logger: { warn() {} },
        repository: {
          async findUserSettings() {
            return {
              createdAt: new Date("2026-05-15T00:00:00Z"),
              locale: "en",
              payload: {},
              slackUserId: "U1",
              teamId: "T1",
              updatedAt: new Date("2026-05-15T00:00:00Z"),
            };
          },
          async saveUserSettings() {},
        },
        teamId: "T1",
        userId: "U1",
      }),
    ).resolves.toBe("en");
  });

  it("falls back to the configured default locale when repository lookup fails", async () => {
    await expect(
      resolveUserSettingsLocale({
        defaultLocale: "ja",
        logger: { warn() {} },
        repository: {
          async findUserSettings() {
            throw new Error("database unavailable");
          },
          async saveUserSettings() {},
        },
        teamId: "T1",
        userId: "U1",
      }),
    ).resolves.toBe("ja");
  });

  it("falls back to the configured default locale when settings are missing", async () => {
    await expect(
      resolveUserSettingsLocale({
        defaultLocale: "ja",
        logger: { warn() {} },
        repository: undefined,
        teamId: "T1",
        userId: "U1",
      }),
    ).resolves.toBe("ja");
  });
});
