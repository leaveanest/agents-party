# TypeScript AgentRunner

OSA-14 introduces the TypeScript agent runtime under `src/agents/`.

The runtime is repository-owned:

- `schemas.ts` defines Zod-validated Slack invocation, agent/specialist routing inputs, and structured result contracts.
- `runner.ts` executes the selected agent runtime, dispatches native specialist runtimes when configured, builds repository domain message history, invokes the `ProviderRouter`, and validates structured translation results.
- `toolContracts.ts` defines typed tool declarations and execution for model tool calls without depending on external agent-framework tool contracts.
- `src/slack/agentHandlers.ts` connects `app_mention` events to the TypeScript `AgentRunner` and replies in the Slack thread.

## Routing Direction

Top-level AI routing should be configuration-driven, not keyword-driven.

The target policy is:

1. resolve the effective agent and model from thread settings
2. fall back to channel defaults
3. fall back to workspace defaults
4. use application defaults only for explicit local/bootstrap configuration

See [`agent-model-routing.md`](agent-model-routing.md) for the routing policy.

Slack event handling resolves an agent/model before calling `AgentRunner`. If no specialist is supplied in the invocation, the runner uses the general assistant instead of guessing from prompt keywords.

Configure the default model with:

```bash
AGENT_MODEL=google:gemini-2.5-flash
```

For local/bootstrap development, `loadSettings` uses `google:gemini-2.5-flash` when `AGENT_MODEL` is not set. This default is only a developer bootstrap default for `AgentRunner`; it is not a `ProviderRouter` model-resolution default.

For production-like runtime configuration, including `APP_ENV=heroku`, `APP_ENV=production`, `APP_ENV=prod`, `APP_ENV=staging`, `NODE_ENV=production`, or Heroku dynos with `DYNO` set, `AGENT_MODEL` is required. Missing `AGENT_MODEL` fails during settings loading so production does not silently choose a provider or model.

The routed Slack surfaces are `app_mention`, active thread follow-up `message` events, and flag-reaction translation commands.

Native specialist runtimes cover:

- web research through `ProviderRouter` with required `web_search`
- Google Maps Places lookup through encrypted workspace credentials, with `GOOGLE_MAPS_API_KEY` only as a local fallback
- typed image generation through provider-aware media gateways with explicit `image_generation` model capability. Google image models use the Google Gen AI SDK; OpenAI image models use AI SDK `generateImage()`.
- typed video generation operation handoff through the Google Gen AI SDK with explicit `video_generation` model capability

These runtimes return Zod-validated structured results and keep provider-specific behavior outside Slack handlers.

OpenAI image generation can be selected with:

```bash
IMAGE_GENERATION_MODEL=openai:gpt-image-1.5
```

Set `workspace_credentials.provider_kind=openai` and `credential_name=api_key` for the Slack workspace. OpenAI image generation does not use process-level API keys; if the DB credential is missing, the specialist fails closed as unconfigured.

Workspace-aware provider credentials are enabled when `DATABASE_URL` and `LLM_API_KEY_ENCRYPTION_KEY` are set. The runner carries Slack `teamId` into `LlmRequest.context.workspaceId`, and provider adapters use that typed context for encrypted `workspace_credentials` lookup instead of inferring credentials from metadata.
