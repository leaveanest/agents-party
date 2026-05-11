export type SlackEventDeduplicator = {
  markProcessing(eventId: string, now?: number): boolean;
};

export class InMemorySlackEventDeduplicator implements SlackEventDeduplicator {
  private readonly seenAtByEventId = new Map<string, number>();

  constructor(
    private readonly ttlMillis = 10 * 60 * 1000,
    private readonly maxEntries = 10_000,
  ) {}

  /**
   * Record one Slack event id if it has not been seen recently.
   *
   * @param eventId - Slack Events API `event_id` value.
   * @param now - Current epoch milliseconds. Injectable for tests.
   * @returns `true` for first processing, `false` for duplicate deliveries.
   */
  markProcessing(eventId: string, now = Date.now()): boolean {
    this.prune(now);
    if (this.seenAtByEventId.has(eventId)) {
      return false;
    }
    this.seenAtByEventId.set(eventId, now);
    this.pruneOverflow();
    return true;
  }

  private prune(now: number): void {
    const oldestAllowed = now - this.ttlMillis;
    for (const [eventId, seenAt] of this.seenAtByEventId.entries()) {
      if (seenAt >= oldestAllowed) {
        continue;
      }
      this.seenAtByEventId.delete(eventId);
    }
  }

  private pruneOverflow(): void {
    while (this.seenAtByEventId.size > this.maxEntries) {
      const oldestKey = this.seenAtByEventId.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        return;
      }
      this.seenAtByEventId.delete(oldestKey);
    }
  }
}

export function readSlackEventId(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const eventId = body.event_id;
  return typeof eventId === "string" && eventId.length > 0 ? eventId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
