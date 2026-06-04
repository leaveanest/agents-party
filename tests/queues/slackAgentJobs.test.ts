import { describe, expect, it } from "vite-plus/test";

import {
  createSlackAgentJobQueue,
  slackAgentJobId,
  slackAgentJobSchema,
} from "../../src/queues/slackAgentJobs.js";

describe("slackAgentJobs", () => {
  it("uses Slack event_id as the primary queue identity", () => {
    const job = slackAgentJobSchema.parse({
      channelId: "C1",
      eventId: "Ev1",
      eventType: "app_mention",
      messageTs: "1712345678.000100",
      teamId: "T1",
      text: "hello",
      threadTs: "1712345678.000100",
      userId: "U1",
    });

    expect(slackAgentJobId(job)).toBe("Ev1");
  });

  it("falls back to a stable Slack event identity when event_id is unavailable", () => {
    const job = slackAgentJobSchema.parse({
      channelId: "C1",
      eventType: "message_follow_up",
      messageTs: "1712345678.000200",
      teamId: "T1",
      text: "follow-up",
      threadTs: "1712345678.000100",
      userId: "U1",
    });

    expect(slackAgentJobId(job)).toBe("T1:message_follow_up:C1:1712345678.000200");
  });

  it("does not retain audio bytes or transcripts in queued job data", () => {
    const job = slackAgentJobSchema.parse({
      audio: new Uint8Array([1, 2, 3]),
      channelId: "C1",
      eventType: "app_mention",
      messageTs: "1712345678.000100",
      teamId: "T1",
      text: "hello",
      threadTs: "1712345678.000100",
      transcript: "derived text",
      transientAttachments: [{ transcript: "derived text" }],
      userId: "U1",
    });

    expect(job).not.toHaveProperty("audio");
    expect(job).not.toHaveProperty("transcript");
    expect(job).not.toHaveProperty("transientAttachments");
  });

  it("does not retain image bytes in queued job data", () => {
    const job = slackAgentJobSchema.parse({
      channelId: "C1",
      eventType: "app_mention",
      image: new Uint8Array([1, 2, 3]),
      messageTs: "1712345678.000100",
      referenceImages: [{ data: new Uint8Array([1, 2, 3]), identifier: "F1" }],
      teamId: "T1",
      text: "",
      threadTs: "1712345678.000100",
      userId: "U1",
    });

    expect(job).not.toHaveProperty("image");
    expect(job).not.toHaveProperty("referenceImages");
  });

  it("does not create a queue when Slack agent queueing is disabled", () => {
    expect(
      createSlackAgentJobQueue({
        databaseBackend: undefined,
        databaseUrl: undefined,
        redisUrl: undefined,
        slackAgentQueueBackend: undefined,
        slackAgentQueueEnabled: false,
      }),
    ).toBeUndefined();
  });

  it("requires PostgreSQL when Slack agent queueing is enabled", () => {
    expect(() =>
      createSlackAgentJobQueue({
        databaseBackend: undefined,
        databaseUrl: undefined,
        redisUrl: "redis://localhost:6379",
        slackAgentQueueBackend: "redis",
        slackAgentQueueEnabled: true,
      }),
    ).toThrow("APP_DATABASE_BACKEND=postgres and DATABASE_URL are required");
  });

  it("requires the Redis queue backend when Slack agent queueing is enabled", () => {
    expect(() =>
      createSlackAgentJobQueue({
        databaseBackend: "postgres",
        databaseUrl: "postgres://localhost/app",
        redisUrl: "redis://localhost:6379",
        slackAgentQueueBackend: undefined,
        slackAgentQueueEnabled: true,
      }),
    ).toThrow("SLACK_AGENT_QUEUE_BACKEND=redis is required");
  });
});
