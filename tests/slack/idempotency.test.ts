import { describe, expect, it } from "vite-plus/test";

import { InMemorySlackEventDeduplicator, readSlackEventId } from "../../src/slack/idempotency.js";

describe("InMemorySlackEventDeduplicator", () => {
  it("allows the first delivery and suppresses duplicate deliveries", () => {
    const deduplicator = new InMemorySlackEventDeduplicator();

    expect(deduplicator.markProcessing("Ev1", 1000)).toBe(true);
    expect(deduplicator.markProcessing("Ev1", 1001)).toBe(false);
  });

  it("allows the same event id again after the ttl expires", () => {
    const deduplicator = new InMemorySlackEventDeduplicator(100);

    expect(deduplicator.markProcessing("Ev1", 1000)).toBe(true);
    expect(deduplicator.markProcessing("Ev1", 1101)).toBe(true);
  });
});

describe("readSlackEventId", () => {
  it("reads Slack Events API event ids", () => {
    expect(readSlackEventId({ event_id: "Ev123" })).toBe("Ev123");
  });

  it("ignores malformed event ids", () => {
    expect(readSlackEventId({ event_id: "" })).toBeUndefined();
    expect(readSlackEventId({ event_id: 123 })).toBeUndefined();
    expect(readSlackEventId(undefined)).toBeUndefined();
  });
});
