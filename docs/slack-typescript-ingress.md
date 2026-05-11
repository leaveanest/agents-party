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

Slack retry metadata remains available on Bolt context:

- `context.retryNum`, from `x-slack-retry-num`
- `context.retryReason`, from `x-slack-retry-reason`

The in-memory deduplicator is process-local. This is enough to avoid repeated local handler execution during a single process lifetime, but horizontally scaled production deployments need a shared idempotency repository. That belongs with the TypeScript persistence cutover.

## Event Coverage

- `app_home_opened`: registered in TypeScript and publishes a minimal home view.
- `app_mention`: registered in TypeScript and routed through the TypeScript `AgentRunner`.
- `message`: registered and acknowledged in TypeScript; active thread follow-ups route through AgentRunner when PostgreSQL thread policy allows auto-reply.
- `reaction_added`: registered and acknowledged in TypeScript; country flag reactions route the target message through the AgentRunner translation specialist.

These gaps are explicit product/runtime boundaries, not fallback paths.
