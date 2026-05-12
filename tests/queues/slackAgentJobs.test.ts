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
});
