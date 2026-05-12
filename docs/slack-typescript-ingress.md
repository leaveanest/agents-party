# TypeScript Slack Ingress

The Slack ingress is implemented with Bolt for JavaScript/TypeScript. There is no Python Slack gateway in the application runtime.

## Endpoints

- `POST /slack/events`: Slack Events API, handled by Bolt `HTTPReceiver`.
- `GET /slack/install`: Slack OAuth install entrypoint when OAuth install settings are present.
- `GET /slack/oauth_redirect`: Slack OAuth redirect endpoint when OAuth install settings are present.

The route paths are configurable with `SLACK_EVENTS_PATH`, `SLACK_INSTALL_PATH`, and `SLACK_OAUTH_REDIRECT_PATH`.

## Configuration

Static bot-token mode requires:

- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN`

Database-backed installation authorization requires:

- `SLACK_SIGNING_SECRET`
- `SLACK_CLIENT_ID`
- `DATABASE_URL`

Slack OAuth install routes additionally require:

- `SLACK_CLIENT_SECRET`
- `SLACK_STATE_SECRET`
- `SLACK_SCOPES`

`SLACK_USER_SCOPES` is optional and comma-separated.

## Ack, Retry, And Idempotency

Bolt `HTTPReceiver` is configured with `processBeforeResponse: false` so Slack requests are acknowledged independently from feature handler completion. Duplicate Events API deliveries are suppressed by `event_id` before feature handlers run.

When `SLACK_AGENT_QUEUE_ENABLED=true`, `REDIS_URL`, and `DATABASE_URL` are configured, app mentions and active thread follow-up messages are handed off to a BullMQ-backed Redis queue. The web process performs request validation, channel/thread policy checks, and enqueue; the worker process runs `AgentRunner`, updates PostgreSQL thread route state, and posts the final Slack reply. Without queue mode enabled, local/runtime behavior falls back to the in-process handler path.

Slack retry metadata remains available on Bolt context:

- `context.retryNum`, from `x-slack-retry-num`
- `context.retryReason`, from `x-slack-retry-reason`

The in-memory deduplicator is process-local. Queued agent jobs also use Redis TTL dedupe keyed by Slack `event_id` or a stable Slack event identity so Slack retries do not enqueue duplicate AI work while the original job is still recent.

## Event Coverage

- `app_home_opened`: registered in TypeScript and publishes a minimal home view.
- `app_mention`: registered in TypeScript and routed through the TypeScript `AgentRunner`, either in-process or through the Redis worker path when configured.
- `message`: registered and acknowledged in TypeScript; active thread follow-ups route through AgentRunner when PostgreSQL thread policy allows auto-reply, either in-process or through the Redis worker path when configured.
- `reaction_added`: registered and acknowledged in TypeScript; country flag reactions route the target message through the AgentRunner translation specialist.

These gaps are explicit product/runtime boundaries, not fallback paths.
