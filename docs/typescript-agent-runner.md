# TypeScript AgentRunner

OSA-14 introduces the TypeScript agent runtime under `src/agents/`.

The runtime is repository-owned:

- `schemas.ts` defines Zod-validated Slack invocation, agent execution decisions, and structured result contracts.
- `runner.ts` executes the resolved agent, builds repository domain message history, invokes the `ProviderRouter`, and runs typed model-selected tools.
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

Slack event handling resolves an agent/model before calling `AgentRunner`. The runner does not accept a separate specialist route; the selected model chooses from the tools attached to the resolved agent.

Configure the default model with:

```bash
AGENT_MODEL=google:gemini-2.5-flash
```

For local/bootstrap development, `loadSettings` uses `google:gemini-2.5-flash` when `AGENT_MODEL` is not set. This default is only a developer bootstrap default for `AgentRunner`; it is not a `ProviderRouter` model-resolution default.

For production-like runtime configuration, including `APP_ENV=heroku`, `APP_ENV=production`, `APP_ENV=prod`, `APP_ENV=staging`, `NODE_ENV=production`, or Heroku dynos with `DYNO` set, `AGENT_MODEL`, `DATABASE_URL`, and `LLM_API_KEY_ENCRYPTION_KEY` are required. Missing `AGENT_MODEL` fails during settings loading so production does not silently choose a provider or model. Missing workspace credential storage settings also fail during settings loading so provider calls cannot silently fall back to process-level provider API keys.

The routed Slack surfaces are `app_mention`, active thread follow-up `message` events, and flag-reaction translation commands.

External capabilities should be exposed as typed tools. The route chooses the agent, model, and allowed tool set; the AI chooses whether to call web, maps, media, Salesforce, SORACOM, or other tools from the conversation context.

SORACOM tools are documented in [`soracom-integration.md`](soracom-integration.md). They are
read-only in the MVP and use workspace-scoped encrypted AuthKey credentials.

OpenAI image generation can be selected with:

```bash
IMAGE_GENERATION_MODEL=openai:gpt-image-1.5
```

Set `workspace_credentials.provider_kind=openai` and `credential_name=api_key` for the Slack workspace. Provider-specific tools should fail closed as unconfigured when the required workspace credential is missing.

Workspace-aware provider credentials are enabled when `DATABASE_URL` and `LLM_API_KEY_ENCRYPTION_KEY` are set, and production-like runtimes require both values. The runner carries Slack `teamId` into `LlmRequest.context.workspaceId`, and provider adapters use that typed context for encrypted `workspace_credentials` lookup instead of inferring credentials from metadata.
