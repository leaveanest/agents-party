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
              scopeId: "T1",
              scopeKind: "team",
              slackUserId: "U1",
              teamId: "T1",
              updatedAt: new Date("2026-05-15T00:00:00Z"),
            };
          },
          async saveUserSettings() {},
        },
        enterpriseId: undefined,
        teamId: "T1",
        userId: "U1",
      }),
    ).resolves.toBe("en");
  });

  it("passes enterprise scope when enterprise id is available", async () => {
    const lookups: unknown[] = [];
    await expect(
      resolveUserSettingsLocale({
        defaultLocale: "ja",
        enterpriseId: "E1",
        logger: { warn() {} },
        repository: {
          async findUserSettings(input) {
            lookups.push(input);
            return {
              createdAt: new Date("2026-05-15T00:00:00Z"),
              enterpriseId: "E1",
              locale: "en",
              payload: {},
              scopeId: "E1",
              scopeKind: "enterprise",
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
    expect(lookups).toEqual([{ enterpriseId: "E1", slackUserId: "U1", teamId: "T1" }]);
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
        enterpriseId: undefined,
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
        enterpriseId: undefined,
        teamId: "T1",
        userId: "U1",
      }),
    ).resolves.toBe("ja");
  });
});
