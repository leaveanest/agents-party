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

`SLACK_USER_SCOPES` is comma-separated. Slack Real-time Search and Slack MCP tools use these
invoking-user token scopes when search or MCP access is enabled.

Canvas generation requires the bot `canvases:write` scope. Existing Slack workspace installations
must reinstall the app after this scope is added, otherwise Canvas creation fails with
`missing_scope`.

Slack-visible fixed copy is localized with the following fallback order:

1. App-level user setting from `app_user_settings.locale`
2. `APP_DEFAULT_LOCALE`
3. `ja`

Supported display locales are `ja` and `en`. Slack `users.info` is not used for routine locale
resolution so Slack API latency and rate limits do not affect normal display text selection. It is
still used where Slack permission checks are required, such as workspace admin checks for privileged
modals. New Slack-visible fixed text should be added through the repository i18n resources instead
of hardcoded in handlers. User input, AI-generated answers, provider names, model ids, Slack action
identifiers, and operational log messages are not translated.

`app_user_settings` keys settings by Slack scope and user. Enterprise Grid events use
`enterprise_id` when it is present; ordinary workspace events use `team_id`. This keeps one user's
enterprise-level preference from being duplicated across teams while preserving team-scoped settings
for non-enterprise installations.

Audio attachment understanding requires the bot `files:read` scope in addition to channel history scopes. Audio bytes are fetched only for the current agent invocation and are kept in memory.

Image attachment understanding uses the same Slack file access boundary. Supported image files (`PNG`, `JPEG`, and `WebP`) are downloaded from Slack private file URLs with the bot token, resized when needed to fit the provider byte target, passed to `AgentRunner` as transient reference image bytes, and kept out of Redis job payloads and persistent storage. Queued jobs re-read the Slack thread and re-download image bytes in the worker. Unsupported image formats and images above the download hard cap are rejected with an ephemeral Slack message to the submitting user.

Slack Real-time Search and Slack MCP tools resolve the invoking user's Slack installation token at
invocation time and fail closed when that user has not installed with user scopes. Do not put Slack
OAuth tokens in Redis jobs or process-wide environment variables for multi-workspace production
traffic; reinstall the app with the manifest user scopes so `installation.user.token` contains the
needed read/search grants.

Transcription uses `TRANSCRIPTION_MODEL` (default `google:speech-to-text-latest-long`), `TRANSCRIPTION_LANGUAGE_CODE` (default `ja-JP`), and `TRANSCRIPTION_ALTERNATIVE_LANGUAGE_CODES` (default `en-US`). Provider credentials are resolved from `workspace_credentials`; Google Speech-to-Text uses `provider_kind=google` and `credential_name=service_account_json`, with the encrypted secret containing the service account JSON. AI SDK transcription providers use their provider kind (`openai`, `groq`, or `azure_openai`) with `credential_name=api_key`.

Text-to-speech is intentionally separate from Slack file transcription. Incoming audio files are transcribed before the agent invocation when Slack file access and transcription credentials are available. Generated speech is an agent tool call (`text_to_speech`) gated by workspace feature settings and channel allowlists, then uploaded back into the Slack thread as audio.

Provider-side data handling is outside application storage. Enable Google Speech-to-Text only for workspaces approved to send audio to Google Cloud. OpenAI, Groq, and Azure OpenAI transcription models are optional workspace-selected routes; enable them only when the workspace has approved that provider's current retention and training terms. The app does not add transcript caching for any provider.

## Ack, Retry, And Idempotency

Bolt `HTTPReceiver` is configured with `processBeforeResponse: false` so Slack requests are acknowledged independently from feature handler completion. Duplicate Events API deliveries are suppressed by `event_id` before feature handlers run.

When `SLACK_AGENT_QUEUE_ENABLED=true`, `REDIS_URL`, and `DATABASE_URL` are configured, app mentions and active thread follow-up messages are handed off to a BullMQ-backed Redis queue. The web process performs request validation, channel/thread policy checks, and enqueue; the worker process re-reads Slack thread context, performs any ephemeral audio transcription, runs `AgentRunner`, updates PostgreSQL thread route state, and posts the final Slack reply. Without queue mode enabled, local/runtime behavior falls back to the in-process handler path.

Completed Redis jobs are retained only briefly for debugging, up to 1 hour or 500 jobs. Failed jobs are retained up to 24 hours or 1,000 jobs.

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
