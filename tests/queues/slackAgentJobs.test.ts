import { describe, expect, it } from "vite-plus/test";

import { slackAgentJobId, slackAgentJobSchema } from "../../src/queues/slackAgentJobs.js";

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

  it("scopes Slack event_id queue identity by app key when present", () => {
    const job = slackAgentJobSchema.parse({
      channelId: "C1",
      eventId: "Ev1",
      eventType: "app_mention",
      messageTs: "1712345678.000100",
      slackAppKey: "agents",
      teamId: "T1",
      text: "hello",
      threadTs: "1712345678.000100",
      userId: "U1",
    });

    expect(slackAgentJobId(job)).toBe("agents:Ev1");
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

  it("scopes fallback queue identity by app key when event_id is unavailable", () => {
    const job = slackAgentJobSchema.parse({
      apiAppId: "A1",
      botUserId: "UBOT",
      channelId: "C1",
      eventType: "message_follow_up",
      messageTs: "1712345678.000200",
      slackAppKey: "agents",
      teamId: "T1",
      text: "follow-up",
      threadTs: "1712345678.000100",
      userId: "U1",
    });

    expect(slackAgentJobId(job)).toBe("agents:T1:message_follow_up:C1:1712345678.000200");
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
});
