import { z } from "zod";

import type { JsonValue } from "../../domain/messageHistory.js";
import type { AgentToolDefinition } from "../toolContracts.js";

const CANVAS_MARKDOWN_LIMIT = 100_000;
const CANVAS_TITLE_LIMIT = 255;

export type CanvasGenerationToolContext = {
  channelId: string;
  teamId: string;
  threadTs: string;
};

export type CanvasGenerationToolOptions = {
  context: CanvasGenerationToolContext;
};

const generateCanvasInputSchema = z
  .object({
    markdown: z.string().trim().min(1).max(CANVAS_MARKDOWN_LIMIT),
    title: z.string().trim().min(1).max(CANVAS_TITLE_LIMIT),
  })
  .strict();

const canvasToolOutputSchema = z
  .object({
    canvas: z
      .object({
        kind: z.literal("canvas"),
        markdown: z.string().min(1).max(CANVAS_MARKDOWN_LIMIT),
        status: z.literal("generated"),
        target: z.object({
          channelId: z.string().min(1),
          teamId: z.string().min(1),
          threadTs: z.string().min(1),
        }),
        title: z.string().min(1).max(CANVAS_TITLE_LIMIT),
      })
      .optional(),
    code: z.string().optional(),
    message: z.string(),
    ok: z.boolean(),
  })
  .strict();

type GenerateCanvasInput = z.infer<typeof generateCanvasInputSchema>;
type CanvasToolOutput = z.infer<typeof canvasToolOutputSchema>;

export function createCanvasGenerationAgentTools(
  options: CanvasGenerationToolOptions,
): AgentToolDefinition[] {
  return [
    {
      description:
        "Create a Slack Canvas draft when the user asks to make, generate, summarize, or turn thread content into a Canvas. Provide a concise title and Slack Canvas-compatible Markdown content. Use this only for Canvas creation requests.",
      execute: async (input) => generateCanvasTool(input as GenerateCanvasInput, options),
      name: "generate_canvas",
      outputSchema: canvasToolOutputSchema as z.ZodType<JsonValue>,
      parameters: z.toJSONSchema(generateCanvasInputSchema) as JsonValue,
      schema: generateCanvasInputSchema as z.ZodType<JsonValue>,
      toModelOutput: async ({ output }) => ({
        type: "json",
        value: modelVisibleCanvasToolOutput(canvasToolOutputSchema.parse(output)),
      }),
    },
  ];
}

async function generateCanvasTool(
  input: GenerateCanvasInput,
  options: CanvasGenerationToolOptions,
): Promise<CanvasToolOutput> {
  return {
    canvas: {
      kind: "canvas",
      markdown: input.markdown,
      status: "generated",
      target: {
        channelId: options.context.channelId,
        teamId: options.context.teamId,
        threadTs: options.context.threadTs,
      },
      title: input.title,
    },
    message: "Canvas generated.",
    ok: true,
  };
}

function modelVisibleCanvasToolOutput(output: CanvasToolOutput): JsonValue {
  if (output.canvas === undefined) {
    return output;
  }
  return {
    ...output,
    canvas: {
      kind: output.canvas.kind,
      status: output.canvas.status,
      title: output.canvas.title,
    },
  };
}
