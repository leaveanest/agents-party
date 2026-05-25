import { describe, expect, it } from "vite-plus/test";

import { fetchSafeRssUrl } from "../../../src/infrastructure/rss/rssUrlSafety.js";

describe("fetchSafeRssUrl", () => {
  it("rejects DNS rebinding between validation and connection lookup", async () => {
    const resolvedAddresses = ["93.184.216.34", "127.0.0.1"];

    await expect(
      fetchSafeRssUrl({
        resolveHostname: async () => [resolvedAddresses.shift() ?? "127.0.0.1"],
        url: "http://rebind.test/feed.xml",
      }),
    ).rejects.toThrow();
  });
});
