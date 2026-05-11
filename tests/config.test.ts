import { describe, expect, it } from "vite-plus/test";

import { loadSettings, parsePort } from "../src/config.js";

describe("loadSettings", () => {
  it("uses local defaults", () => {
    expect(loadSettings({})).toEqual({
      appEnv: "local",
      appHost: "0.0.0.0",
      appName: "agents-party",
      appPort: 8000,
    });
  });

  it("prefers PORT over APP_PORT for platform deployments", () => {
    expect(loadSettings({ APP_PORT: "9000", PORT: "8080" }).appPort).toBe(8080);
  });
});

describe("parsePort", () => {
  it("rejects invalid port values", () => {
    expect(() => parsePort("70000", 8000)).toThrow(
      "APP_PORT or PORT must be an integer between 1 and 65535.",
    );
  });
});
