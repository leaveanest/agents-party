import { z } from "zod";

export const slackReferenceImageSchema = z
  .object({
    data: z.instanceof(Uint8Array).optional(),
    identifier: z.string().min(1),
    mediaType: z.string().min(1),
    messageTs: z.string().min(1).optional(),
    url: z.string().url().optional(),
  })
  .strict();

export const slackTransientAudioAttachmentSchema = z
  .object({
    filename: z.string().min(1).optional(),
    id: z.string().min(1),
    kind: z.literal("audio"),
    mediaType: z.string().min(1),
    messageTs: z.string().min(1).optional(),
    transcript: z.string().min(1).optional(),
  })
  .strict();

export const slackThreadHistoryMessageSchema = z.discriminatedUnion("role", [
  z
    .object({
      messageTs: z.string().min(1).optional(),
      role: z.literal("user"),
      teamId: z.string().min(1),
      text: z.string().min(1),
      userId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      botId: z.string().min(1).optional(),
      messageTs: z.string().min(1).optional(),
      role: z.literal("assistant"),
      teamId: z.string().min(1).optional(),
      text: z.string().min(1),
      userId: z.string().min(1).optional(),
    })
    .strict(),
]);

export const slackAgentInvocationSchema = z
  .object({
    channelId: z.string().min(1),
    enterpriseId: z.string().min(1).optional(),
    isEnterpriseInstall: z.boolean().optional(),
    messageTs: z.string().min(1),
    modelId: z
      .preprocess(
        (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
        z.string().trim().min(1).optional(),
      )
      .optional(),
    reasoningEffort: z
      .preprocess(
        (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
        z
          .enum(["provider_default", "none", "minimal", "low", "medium", "high", "xhigh"])
          .optional(),
      )
      .optional(),
    referenceImages: z.array(slackReferenceImageSchema).default([]),
    teamId: z.string().min(1),
    text: z.string().default(""),
    threadHistory: z.array(slackThreadHistoryMessageSchema).default([]),
    threadMessages: z.array(z.string()).default([]),
    threadTs: z.string().min(1).optional(),
    transientAttachments: z.array(slackTransientAudioAttachmentSchema).default([]),
    userId: z.string().min(1),
    viewerContextChannelIds: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const agentRouterDecisionSchema = z
  .object({
    action: z.literal("respond").default("respond"),
    reason: z.string().default("agent_invocation"),
  })
  .strict();

export const agentTextResultSchema = z
  .object({
    message: z.string().min(1),
  })
  .strict();

export type AgentRouterDecision = z.infer<typeof agentRouterDecisionSchema>;
export type SlackAgentInvocation = z.infer<typeof slackAgentInvocationSchema>;
