# TypeScript AgentRunner

OSA-14 introduces the TypeScript agent runtime under `src/agents/`.

The runtime is repository-owned rather than `pydantic-ai`-owned:

- `schemas.ts` defines Zod-validated Slack invocation, specialist routing, and structured result contracts.
- `runner.ts` selects a specialist, dispatches native specialist runtimes when available, builds repository domain message history, invokes the `ProviderRouter`, and validates structured work-manager/translation results.
- `toolContracts.ts` defines typed tool declarations and execution for model tool calls without depending on Python `pydantic-ai` tool contracts.
- `src/slack/agentHandlers.ts` connects `app_mention` events to the TypeScript `AgentRunner` and replies in the Slack thread.

Configure the default model with:

```bash
AGENT_MODEL=google:gemini-2.5-flash
```

If `AGENT_MODEL` is not set, the TypeScript runtime falls back to `WORK_MANAGER_MODEL`, then `google:gemini-2.5-flash`.

The routed Slack surfaces are `app_mention`, active thread follow-up `message` events, and flag-reaction translation commands.

Native specialist runtimes cover:

- web research through `ProviderRouter` with required `web_search`
- Google Maps Places lookup through `GOOGLE_MAPS_API_KEY`
- typed image generation through the Google Gen AI SDK with explicit `image_generation` model capability
- typed video generation operation handoff through the Google Gen AI SDK with explicit `video_generation` model capability

These runtimes return Zod-validated structured results and keep provider-specific behavior outside Slack handlers.
