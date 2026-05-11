# TypeScript AgentRunner

OSA-14 introduces the TypeScript agent runtime under `src/agents/`.

The runtime is repository-owned rather than `pydantic-ai`-owned:

- `schemas.ts` defines Zod-validated Slack invocation, specialist routing, and structured result contracts.
- `runner.ts` selects a specialist, builds repository domain message history, invokes the `ProviderRouter`, and validates structured work-manager/translation results.
- `toolContracts.ts` defines typed tool declarations and execution for model tool calls without depending on Python `pydantic-ai` tool contracts.
- `src/slack/agentHandlers.ts` connects `app_mention` events to the TypeScript `AgentRunner` and replies in the Slack thread.

Configure the default model with:

```bash
AGENT_MODEL=google:gemini-2.5-flash
```

If `AGENT_MODEL` is not set, the TypeScript runtime falls back to `WORK_MANAGER_MODEL`, then `google:gemini-2.5-flash`.

The first routed Slack surface is `app_mention`. Thread follow-up auto-routing and reaction commands are split to Linear issue OSA-18. Native web research, Google Maps, image generation, and video generation integrations are split to Linear issue OSA-19. Both follow-ups should build on these contracts rather than reintroducing Python agent runtime assumptions.
