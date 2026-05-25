import type { ToolSet } from "ai";

import type { JsonValue } from "../domain/messageHistory.js";

export const aiSdkToolExecutionOutputsSymbol = Symbol.for("agents-party.aiSdkToolExecutionOutputs");

export type AiSdkToolExecutionOutputs = Map<string, JsonValue>;

export type AiSdkToolSetWithExecutionOutputs = ToolSet & {
  [aiSdkToolExecutionOutputsSymbol]?: AiSdkToolExecutionOutputs;
};
