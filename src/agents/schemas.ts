import { z } from "zod";

export const agentSpecialistSchema = z.enum([
  "assistant",
  "google_maps",
  "image_generation",
  "translation",
  "video_generation",
  "web_research",
  "work_manager",
]);

export const slackReferenceImageSchema = z
  .object({
    data: z.instanceof(Uint8Array).optional(),
    identifier: z.string().min(1),
    mediaType: z.string().min(1),
    messageTs: z.string().min(1).optional(),
    url: z.string().url().optional(),
  })
  .strict();

export const slackAgentInvocationSchema = z
  .object({
    channelId: z.string().min(1),
    messageTs: z.string().min(1),
    modelId: z
      .preprocess(
        (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
        z.string().trim().min(1).optional(),
      )
      .optional(),
    referenceImages: z.array(slackReferenceImageSchema).default([]),
    specialist: agentSpecialistSchema.optional(),
    teamId: z.string().min(1),
    text: z.string().default(""),
    threadMessages: z.array(z.string()).default([]),
    threadTs: z.string().min(1).optional(),
    userId: z.string().min(1),
    viewerContextChannelIds: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const agentRouterDecisionSchema = z
  .object({
    confidence: z.number().min(0).max(1).default(1),
    reason: z.string().default("keyword_match"),
    specialist: agentSpecialistSchema,
  })
  .strict();

export const workManagerActionSchema = z.enum([
  "clarification_needed",
  "completed",
  "created",
  "listed",
  "no_op",
  "updated",
]);

export const workManagerResultSchema = z
  .object({
    action: workManagerActionSchema.default("no_op"),
    message: z.string().min(1),
    workItems: z
      .array(
        z
          .object({
            dueAt: z.string().optional(),
            status: z.string().optional(),
            title: z.string().min(1),
            workItemId: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const translationResultSchema = z
  .object({
    action: z.enum(["no_op", "translated"]).default("translated"),
    message: z.string().optional(),
    sourceLanguage: z.string().optional(),
    targetLanguage: z.string().optional(),
    translatedText: z.string().optional(),
  })
  .strict();

export const specialistTextResultSchema = z
  .object({
    message: z.string().min(1),
  })
  .strict();

export type AgentRouterDecision = z.infer<typeof agentRouterDecisionSchema>;
export type AgentSpecialist = z.infer<typeof agentSpecialistSchema>;
export type SlackAgentInvocation = z.infer<typeof slackAgentInvocationSchema>;
export type TranslationResult = z.infer<typeof translationResultSchema>;
export type WorkManagerResult = z.infer<typeof workManagerResultSchema>;
