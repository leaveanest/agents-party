# TypeScript Slack Ingress

The Slack ingress is implemented with Bolt for JavaScript/TypeScript. There is no Python Slack gateway in the application runtime.

## Endpoints

- `POST /slack/events`: Slack Events API, handled by Bolt `HTTPReceiver`.
- `GET /slack/install`: Slack OAuth install entrypoint when OAuth install settings are present.
- `GET /slack/oauth_redirect`: Slack OAuth redirect endpoint when OAuth install settings are present.

The route paths are configurable with `SLACK_EVENTS_PATH`, `SLACK_INSTALL_PATH`, and `SLACK_OAUTH_REDIRECT_PATH`.

## Configuration

Database-backed installation authorization requires:

- `SLACK_SIGNING_SECRET`
- `SLACK_CLIENT_ID`
- `DATABASE_URL`

Slack OAuth install routes additionally require:

- `SLACK_CLIENT_SECRET`
- `SLACK_STATE_SECRET`
- `SLACK_SCOPES`

`SLACK_USER_SCOPES` is optional and comma-separated.

Slack-visible fixed copy is localized with the following fallback order:

1. Slack user locale from `users.info` with `include_locale=true`
2. `APP_DEFAULT_LOCALE`
3. `ja`

Supported display locales are `ja` and `en`. New Slack-visible fixed text should be added through
the repository i18n resources instead of hardcoded in handlers. User input, AI-generated answers,
provider names, model ids, Slack action identifiers, and operational log messages are not translated.

Audio attachment understanding requires the bot `files:read` scope in addition to channel history scopes. Audio bytes are fetched only for the current agent invocation and are kept in memory.

Transcription uses `TRANSCRIPTION_MODEL` (default `google:speech-to-text-latest-long`), `TRANSCRIPTION_LANGUAGE_CODE` (default `ja-JP`), and `TRANSCRIPTION_ALTERNATIVE_LANGUAGE_CODES` (default `en-US`). Provider credentials are resolved from `workspace_credentials`; Google Speech-to-Text uses `provider_kind=google` and `credential_name=service_account_json`, with the encrypted secret containing the service account JSON. AI SDK transcription providers use their provider kind (`openai`, `groq`, or `azure_openai`) with `credential_name=api_key`.

Provider-side data handling is outside application storage. Enable Google Speech-to-Text only for workspaces approved to send audio to Google Cloud. OpenAI, Groq, and Azure OpenAI transcription models are optional workspace-selected routes; enable them only when the workspace has approved that provider's current retention and training terms. The app does not add transcript caching for any provider.

## Ack, Retry, And Idempotency

Bolt `HTTPReceiver` is configured with `processBeforeResponse: false` so Slack requests are acknowledged independently from feature handler completion. Duplicate Events API deliveries are suppressed by `event_id` before feature handlers run.

When `SLACK_AGENT_QUEUE_ENABLED=true`, `REDIS_URL`, and `DATABASE_URL` are configured, app mentions and active thread follow-up messages are handed off to a BullMQ-backed Redis queue. The web process performs request validation, channel/thread policy checks, and enqueue; the worker process re-reads Slack thread context, performs any ephemeral audio transcription, runs `AgentRunner`, updates PostgreSQL thread route state, and posts the final Slack reply. Without queue mode enabled, local/runtime behavior falls back to the in-process handler path.

Slack retry metadata remains available on Bolt context:

- `context.retryNum`, from `x-slack-retry-num`
- `context.retryReason`, from `x-slack-retry-reason`

The in-memory deduplicator is process-local. Queued agent jobs also use Redis TTL dedupe keyed by Slack `event_id` or a stable Slack event identity so Slack retries do not enqueue duplicate AI work while the original job is still recent.

## Event Coverage

- `app_home_opened`: registered in TypeScript and publishes a minimal home view.
- `app_mention`: registered in TypeScript and routed through the TypeScript `AgentRunner`, either in-process or through the Redis worker path when configured.
- `message`: registered and acknowledged in TypeScript; active thread follow-ups route through AgentRunner when PostgreSQL thread policy allows auto-reply, either in-process or through the Redis worker path when configured.
- `reaction_added`: registered and acknowledged in TypeScript; country flag reactions route the target message through the resolved AgentRunner path with a translation instruction.

These gaps are explicit product/runtime boundaries, not fallback paths.
