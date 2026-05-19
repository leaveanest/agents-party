# agents-party

`agents-party` is a Slack-native agent routing application built on a TypeScript/Node.js runtime.
It uses Slack Bolt for JavaScript/TypeScript, AI SDK behind repository-owned provider adapters, PostgreSQL, and Terraform.

## TypeScript Runtime Status

The TypeScript runtime currently exposes:

- `GET /healthz`
- `POST /slack/events`
- `GET /slack/install` when Slack OAuth install settings are present
- `GET /slack/oauth_redirect` when Slack OAuth install settings are present
- `GET /oauth/google/start` when Google OAuth settings are present
- `GET /oauth/google/callback` when Google OAuth settings are present
- `GET /oauth/salesforce/start` when Salesforce OAuth settings are present
- `GET /oauth/salesforce/callback` when Salesforce OAuth settings are present
- `POST /oauth/salesforce/disconnect` when Salesforce OAuth settings are present

The TypeScript Slack ingress initializes Bolt for JavaScript/TypeScript, validates Slack signatures through Bolt, acknowledges Events API deliveries, and suppresses duplicate event deliveries by Slack `event_id`.
See [`docs/slack-typescript-ingress.md`](docs/slack-typescript-ingress.md) for the current ingress boundary.

The TypeScript domain history model represents text, image, file/PDF, audio, assistant, and tool-result events without storing AI SDK `ModelMessage[]`.
See [`docs/message-history-model.md`](docs/message-history-model.md) for the conversion boundary.

The TypeScript provider boundary defines `ProviderRouter`, model registry, provider contracts, capability checks, and an AI SDK common adapter lane for OpenAI, Azure OpenAI, Anthropic, Google, Groq, xAI, PLaMo, NVIDIA, and LiteLLM.
See [`docs/provider-router.md`](docs/provider-router.md) for the routing and capability boundary.

Agent routing through `app_mention`, active thread follow-up auto-routing, flag-reaction translation commands, native specialist runtimes, Google/Salesforce OAuth routes, PostgreSQL-backed OAuth state, encrypted token persistence, Salesforce token refresh, and Salesforce revoke-backed disconnect are available in the TypeScript runtime. Full App Home settings and native provider adapters for Bedrock/Dify/provider-specific features remain planned work.

Salesforce PDF workflows can generate Quote PDFs and Deal Review Packs from Salesforce data through
Slack agent tools when Salesforce OAuth, PostgreSQL, and Slack-admin workflow settings are
configured. Workflows are disabled by default and Salesforce Files attachment requires explicit
confirmation. See [`docs/salesforce-pdf-workflows.md`](docs/salesforce-pdf-workflows.md).

The Python application runtime has been removed. Repository-local Codex development helpers under `.agents/skills/` use the TypeScript toolchain and are not part of the app, tests, deploy, or package workflow.

## Data Handling / External Providers

`agents-party` processes Slack events, messages, and thread context so configured agents and providers can execute requested work. Slack message text, thread context, and supported attachments may be sent to the configured model provider at invocation time; media and specialist features may additionally send files, images, PDFs, or audio to configured external providers for transcription, image generation, video generation, search, or related tool execution. See [`docs/slack-typescript-ingress.md`](docs/slack-typescript-ingress.md), [`docs/message-history-model.md`](docs/message-history-model.md), and [`docs/provider-router.md`](docs/provider-router.md) for the Slack ingress, message conversion, and provider boundary.

Provider-side retention, training, logging, and data handling terms depend on the selected provider, account, region, feature, and operator configuration. OSS operators should review each provider's current terms before enabling it for a workspace.

In production, keep OAuth tokens and workspace provider API keys in the runtime's encrypted repository-backed stores where those flows are implemented, and inject static Slack, OAuth client, encryption, and fallback provider secrets through the deployment platform or CI secret manager. The [`Specialists`](#specialists) configuration notes describe workspace credential resolution and local fallback keys. Do not rely on process-level provider keys for multi-workspace production traffic.

Terraform state can contain managed values, so it should not contain Slack secrets, OAuth secrets, provider API keys, encryption keys, or other credentials. Keep secrets outside Terraform state as described in [`Deployment`](#deployment).

## Agent And Specialist Runtimes

Top-level Slack AI routing is moving toward explicit workspace, channel, and thread configuration. See [`docs/agent-model-routing.md`](docs/agent-model-routing.md) for the target policy.

Selected agents can use these specialist runtimes internally:

- `web_research`
  - current, source-backed web research using built-in web tools
- `google_maps`
  - place lookup, nearby search, and route guidance using Google Maps APIs
- `translation`
  - language translation from Slack context
- `image_generation`
  - image generation using Gemini image models
- `video_generation`
  - text-to-video planning and rendering using Gemini plus Veo

Media specialists return generated bytes, a provider URI, or a long-running operation handoff that is posted back into the Slack thread.

## Built-in Agent Skills

Repository-managed built-in skill documents live under [`skills/`](skills/). Runtime integration for skill-like behavior should be implemented in TypeScript under `src/agents/` or `src/providers/`.

Current built-in skills:

- `airport-transfer-planner`
- `area-safety-and-convenience-checker`
- `budget-stay-optimizer`
- `dispatch-triage`
- `family-stay-advisor`
- `handover-brief-builder`
- `itinerary-gap-checker`
- `lodging-search-advisor`
- `meeting-location-advisor`
- `shipper-communication-drafter`
- `web-research-analyst`

Repository-local Codex skills for development live under [`.agents/skills/`](.agents/skills/).

## Local Setup

`agents-party` can run in two local modes:

- health-check only, with no Slack credentials
- Slack development, using PostgreSQL-backed Slack OAuth installation storage

### Prerequisites

- Node.js 22.x
- `vp` for all JavaScript/TypeScript workflows in this repository
- Docker Compose, when using local PostgreSQL or Redis
- A Slack workspace where you can create or install an app, when testing Slack events

If `vp` is not available, install or fix `vp` before continuing. Do not switch to `npm`, `pnpm`,
`yarn`, or `bun` for normal repository workflows.

### 1. Install Dependencies

```bash
vp install
```

### 2. Start The App Without Slack

This is the fastest smoke test. Without Slack settings the server still starts and exposes
`GET /healthz`.

```bash
vp run dev
```

In another shell:

```bash
curl http://localhost:8000/healthz
```

### 3. Add Local PostgreSQL

PostgreSQL is required for migrations, workspace routing, OAuth state, Slack installation storage,
and encrypted workspace credentials.

```bash
docker compose up -d postgres
export DATABASE_URL=postgresql://agents_party:agents_party@localhost:5432/agents_party
vp run migrate
```

See [`docs/postgres-typescript-migrations.md`](docs/postgres-typescript-migrations.md) for migration
policy and rollout notes.

### 4. Configure Slack Locally

Use the Slack App Manifest template at [`slack-app-manifest.yaml`](slack-app-manifest.yaml).
Replace `agents-party.example.com` with a public HTTPS tunnel URL that forwards to
`http://localhost:8000` before importing the manifest into Slack.

Use PostgreSQL plus Slack OAuth settings for local Slack testing:

```bash
export SLACK_SIGNING_SECRET=...
export SLACK_CLIENT_ID=...
export SLACK_CLIENT_SECRET=...
export SLACK_STATE_SECRET=...
export DATABASE_URL=postgresql://agents_party:agents_party@localhost:5432/agents_party
vp run migrate
vp run dev
```

The default local bootstrap model is `google:gemini-2.5-flash`. Set `AGENT_MODEL` to another
registered provider model id when testing a different provider. Store provider API keys in
workspace credentials when `LLM_API_KEY_ENCRYPTION_KEY` is configured, or use provider-package
local environment fallback only for isolated local testing. Never commit provider keys.

The TypeScript runtime exposes these local routes:

- `GET /healthz`
- `POST /slack/events`
- `GET /slack/install` when Slack OAuth install settings are present
- `GET /slack/oauth_redirect` when Slack OAuth install settings are present

### 5. Seed A Workspace Route

After migrations, seed a first Slack workspace route so app mentions can resolve the default agent
and model. Use the Slack workspace team id for `AGENTS_PARTY_BOOTSTRAP_TEAM_ID`.

```bash
DATABASE_URL=postgresql://agents_party:agents_party@localhost:5432/agents_party \
AGENT_MODEL=google:gemini-2.5-flash \
AGENTS_PARTY_BOOTSTRAP_TEAM_ID=T123456789 \
vp run seed:bootstrap
```

The bootstrap seed creates an enabled `assistant` agent and sets the workspace default agent/model.
Use `AGENTS_PARTY_BOOTSTRAP_ENABLED_CHANNEL_IDS=C123,C456` to restrict the first enabled channels;
omitting it enables all channels until workspace settings are tightened.

### 6. Validate Changes

Run the normal validation set before opening a pull request:

```bash
vp check
vp run typecheck
vp test
vp pack
```

Use [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution expectations and project boundaries.
Use [`.env.example`](.env.example) as a local environment reference. Docker Compose reads `.env`
automatically; `vp run ...` commands use variables exported in the current shell.

### Local Worker Queue

Slack AI chat handling can run in-process for local development. To test Redis-backed handoff,
start Redis and run the web and worker processes separately:

```bash
docker compose up -d redis
SLACK_AGENT_QUEUE_ENABLED=true REDIS_URL=redis://localhost:6379 vp run dev
REDIS_URL=redis://localhost:6379 \
DATABASE_URL=postgresql://agents_party:agents_party@localhost:5432/agents_party \
vp run worker
```

### Terraform Deployment

Terraform applies the Heroku dev environment under
[`terraform/environments/dev/`](terraform/environments/dev/). Use it for Heroku app, Postgres,
Redis/KVS, buildpack, non-secret config vars, and optional dyno formation. Keep local development on
Docker Compose until you are ready to test against Heroku.

## Local Container

This repository includes a root `Dockerfile` for local container checks only.
Heroku production deploys use Heroku buildpacks and the root `Procfile` instead of Docker image deployment.

Build locally if needed:

```bash
docker build -t agents-party .
```

Run a local stack with PostgreSQL, Redis, migrations, web, and worker:

```bash
docker compose up --build web worker
```

In another shell:

```bash
curl http://localhost:8000/healthz
```

Seed a local bootstrap Slack workspace route in the same stack:

```bash
docker compose --profile seed run --rm seed
```

The compose defaults start without Slack credentials so the server can be health-checked locally.
To test real Slack requests, copy [`.env.example`](.env.example) to `.env`, fill the Slack OAuth
settings, point your Slack App Manifest public HTTPS tunnel at `http://localhost:8000`, and rerun
the stack. Docker Compose uses the container-internal PostgreSQL and Redis URLs from
[`compose.yaml`](compose.yaml), even if `.env` contains localhost URLs for `vp run ...` workflows.

## Configuration

The TypeScript runtime reads configuration from process environment variables.

### Core runtime

```bash
APP_ENV=local
APP_HOST=0.0.0.0
APP_PORT=8000
APP_DEFAULT_LOCALE=ja
```

`APP_DEFAULT_LOCALE` controls Slack-visible fallback display language when no app-level user
setting exists. Supported values are `ja` and `en`; unsupported values fall back to `ja`.

### Slack

The Slack App Manifest template is [`slack-app-manifest.yaml`](slack-app-manifest.yaml).
Replace `agents-party.example.com` with the public HTTPS host before importing it into Slack.

Slack runtime authorization uses the database-backed Slack installation store. Per-user display
preferences such as locale are stored in `app_user_settings`; the settings scope uses
`enterprise_id` when present, otherwise `team_id`. Slack `users.info` is reserved for permission
checks such as workspace admin detection, not for routine locale resolution.

```bash
SLACK_SIGNING_SECRET=...
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_STATE_SECRET=...
SLACK_SCOPES=app_mentions:read,channels:history,chat:write,files:read,files:write,groups:history,im:history,mpim:history,reactions:read,users:read
SLACK_USER_SCOPES=channels:history,groups:history,im:history,mpim:history,search:read.public,users:read,users:read.email
SLACK_EVENTS_PATH=/slack/events
SLACK_INSTALL_PATH=/slack/install
SLACK_OAUTH_REDIRECT_PATH=/slack/oauth_redirect
APP_DEFAULT_LOCALE=ja
AGENT_MODEL=google:gemini-2.5-flash
```

`AGENT_MODEL` is the application bootstrap/fallback model passed to the TypeScript `AgentRunner`
when Slack routing has not supplied a thread, channel, or workspace model. Local development can
omit it and use the bootstrap default `google:gemini-2.5-flash`. Production-like runtimes,
including Heroku dynos and `APP_ENV=heroku` or `NODE_ENV=production`, require `AGENT_MODEL`;
startup fails closed if it is missing.

Slack MCP tools use the invoking user's Slack OAuth token, not a static workspace token. Keep
`SLACK_USER_SCOPES` aligned with the manifest's user scopes before reinstalling the Slack app so
the worker and in-process agent paths can resolve that user's `installation.user.token` for MCP calls.

### Specialists

```bash
IMAGE_GENERATION_MODEL=google:gemini-2.5-flash-image
VIDEO_GENERATION_MODEL=google:veo-3.1-fast-generate-001
LLM_API_KEY_ENCRYPTION_KEY=...
```

When `DATABASE_URL` and `LLM_API_KEY_ENCRYPTION_KEY` are configured, LLM and specialist API keys are resolved from encrypted rows in the PostgreSQL `workspace_credentials` table by Slack `team_id`. Slack workspace admins and owners can register or rotate those keys from App Home by opening the API keys configuration modal. Google text models prefer `provider_kind='google'` / `credential_name='service_account_json'` for Vertex AI service account JSON, then fall back to `credential_name='api_key'` for Google Generative AI API keys. Production-like runtimes (`APP_ENV=heroku`, `APP_ENV=prod`, `APP_ENV=production`, `APP_ENV=staging`, `NODE_ENV=production`, or Heroku dynos with `DYNO` set) require both values at startup so provider calls cannot silently fall back to process-level provider keys. Without that resolver, isolated local development can still use process-level provider environment variables supported by the AI SDK provider packages.

### S3-compatible object storage

The runtime can be configured for S3-compatible object storage with common `OBJECT_STORAGE_*`
settings. AWS deployments should use ECS task-role credentials. Heroku deployments should use the
Bucketeer add-on; the runtime treats Bucketeer config vars as defaults for the same object storage
settings.

```bash
OBJECT_STORAGE_BUCKET=agents-party-objects
OBJECT_STORAGE_REGION=ap-northeast-1
OBJECT_STORAGE_ACCESS_KEY_ID=
OBJECT_STORAGE_SECRET_ACCESS_KEY=
OBJECT_STORAGE_ENDPOINT=
OBJECT_STORAGE_FORCE_PATH_STYLE=false
OBJECT_STORAGE_PREFIX=prod
OBJECT_STORAGE_PUBLIC_BASE_URL=
```

For Heroku Bucketeer, the add-on provides `BUCKETEER_BUCKET_NAME`, `BUCKETEER_AWS_REGION`,
`BUCKETEER_AWS_ACCESS_KEY_ID`, and `BUCKETEER_AWS_SECRET_ACCESS_KEY`. Do not copy those secret
values into Terraform-managed config vars. `OBJECT_STORAGE_ENDPOINT` can stay unset for AWS S3 and
Bucketeer; set it only for S3-compatible services that require a custom endpoint.

### Local database

Use a direct PostgreSQL URL for local development and one-off verification:

```bash
DATABASE_URL=postgresql://user:password@localhost:5432/agents_party
```

### Heroku database

Production on Heroku uses the `DATABASE_URL` config var created by the Heroku Postgres add-on.
TypeScript-managed migrations use this value.

```bash
DATABASE_URL=postgres://...
```

Do not use SQLAlchemy-style driver-prefixed URLs with `vp run migrate` or `pg` repositories:

```bash
DATABASE_URL=postgresql+psycopg://user:password@localhost:5432/agents_party
```

### Google OAuth

```bash
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_BASE_URL=https://...
GOOGLE_OAUTH_CONTEXT_SIGNING_SECRET=...
GOOGLE_TOKEN_ENCRYPTION_KEY=...
```

The registered Google redirect URI is `${GOOGLE_OAUTH_REDIRECT_BASE_URL}/oauth/google/callback` unless `GOOGLE_OAUTH_CALLBACK_PATH` is overridden.

### Salesforce OAuth

```bash
SALESFORCE_OAUTH_REDIRECT_BASE_URL=https://...
SALESFORCE_OAUTH_CONTEXT_SIGNING_SECRET=...
SALESFORCE_OAUTH_DISCONNECT_PATH=/oauth/salesforce/disconnect
SALESFORCE_TOKEN_ENCRYPTION_KEY=...
```

The registered Salesforce redirect URI is `${SALESFORCE_OAUTH_REDIRECT_BASE_URL}/oauth/salesforce/callback` unless `SALESFORCE_OAUTH_CALLBACK_PATH` is overridden. Workspace-specific Salesforce client IDs, optional encrypted client secrets, My Domain hosts, and org IDs are read from the PostgreSQL `salesforce_auth_configs` table.
Salesforce PDF workflow settings are stored per Slack workspace, Salesforce org, and action in
`salesforce_pdf_workflow_settings`. Run `vp run migrate` before enabling the workflows, then have a
Slack workspace admin configure `quote_pdf` and/or `deal_review_pack` from App Home. The connected
Salesforce user still needs Salesforce object, field, sharing, and Files permissions for the
records being read or attached.

### Google Maps

For local fallback only:

```bash
GOOGLE_MAPS_API_KEY=...
```

For shared or production-like runtimes, store the Google Maps key in `workspace_credentials` with `provider_kind='google_maps'` and `credential_name='api_key'`. Slack admins can configure workspace API keys from App Home when credential storage is enabled. `GOOGLE_MAPS_API_KEY` remains a local fallback only.

### Media Generation Tools

```bash
IMAGE_GENERATION_MODEL=google:gemini-2.5-flash-image
VIDEO_GENERATION_MODEL=google:veo-3.1-fast-generate-001
```

The TypeScript runner exposes image generation as a callable agent tool. The normal Slack agent model decides whether to call `generate_image`; the tool then checks workspace feature settings, channel allowlists, model capabilities, and workspace credentials before calling a provider-aware media gateway. In workspace-credential mode it uses the encrypted provider credential row for the Slack team, for example `provider_kind='google'` / `credential_name='api_key'` for Google image models and `provider_kind='openai'` / `credential_name='api_key'` for OpenAI image models.

Image generation is deny-by-default. A workspace admin or owner must configure the required provider API key, open Feature settings from App Home, enable image generation for the workspace, and choose allowed channels. The tool only runs when the required provider API key exists, workspace `image_generation` is enabled, and the Slack channel is explicitly allowlisted. Thread-level feature settings are not used.

## Deployment

Heroku production deploys use:

- Heroku Node.js buildpack, configured by Terraform
- root `Procfile`
  - `web: node dist/main.mjs`
  - `worker: node dist/worker.mjs`
  - `rss_worker: node dist/rssFeedWorker.mjs`
- `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml` for the TypeScript runtime
- Heroku Postgres add-on for `DATABASE_URL`
- Heroku Key-Value Store/Redis add-on for `REDIS_URL`

Terraform for the Heroku app, add-ons, buildpack, non-secret config vars, optional Bucketeer object
storage, and optional web formation lives under `terraform/environments/dev/`.
AWS/Fargate infrastructure lives under `terraform/environments/aws/`.

Secret values are intentionally not managed by Terraform because Terraform state can contain managed config values. Set Slack, OAuth, encryption, Salesforce, and external API secrets through `heroku config:set` or CI secret injection instead.
The Heroku provider is configured to avoid storing unmanaged app config vars and add-on config var values in Terraform state.

1. Apply infrastructure:

```bash
cd terraform/environments/dev
export HEROKU_API_KEY=...
terraform init
terraform apply -var-file=terraform.tfvars
```

The Heroku Terraform provider reads credentials from `HEROKU_API_KEY` or an authenticated Heroku CLI/netrc session. Do not put the API key in `.tfvars`.

2. Set required secrets outside Terraform:

```bash
heroku config:set \
  SLACK_SIGNING_SECRET=... \
  SLACK_CLIENT_ID=... \
  SLACK_CLIENT_SECRET=... \
  SLACK_STATE_SECRET=... \
  LLM_API_KEY_ENCRYPTION_KEY=... \
  GOOGLE_OAUTH_REDIRECT_BASE_URL=https://... \
  GOOGLE_OAUTH_CLIENT_ID=... \
  GOOGLE_OAUTH_CLIENT_SECRET=... \
  GOOGLE_OAUTH_CONTEXT_SIGNING_SECRET=... \
  GOOGLE_TOKEN_ENCRYPTION_KEY=... \
  SALESFORCE_OAUTH_REDIRECT_BASE_URL=https://... \
  SALESFORCE_OAUTH_CONTEXT_SIGNING_SECRET=... \
  SALESFORCE_TOKEN_ENCRYPTION_KEY=... \
  -a agents-party-dev
```

3. Deploy from Git to Heroku so the Node buildpack reads the TypeScript package metadata and `Procfile`:

```bash
heroku git:remote -a agents-party-dev
git push heroku main
```

4. After the first release has created the `web` and `worker` process types, set `manage_web_formation = true`, `manage_worker_formation = true`, and `slack_agent_queue_enabled = true` in `terraform.tfvars` and re-apply Terraform if you want Terraform to own dyno quantity and size and route Slack AI chat work through Redis.

5. To run RSS feed batches on Heroku, set `enable_scheduler = true`, re-apply Terraform, then add a Heroku Scheduler job for `node dist/rssFeedWorker.mjs` at the same cadence as AWS, normally every 10 minutes. Terraform provisions the Scheduler add-on, but Heroku Scheduler job definitions are managed in the Heroku Scheduler UI.

Slack AI chat handling uses Redis-backed worker processing when `SLACK_AGENT_QUEUE_ENABLED=true`, `REDIS_URL`, and `DATABASE_URL` are configured. The web dyno verifies Slack requests, performs lightweight policy checks, enqueues `app_mention` and active thread follow-up work, and returns independently from provider execution. The worker dyno consumes the queue, runs `AgentRunner`, persists thread route state, and posts the final Slack thread reply. If queue mode is not enabled, local development keeps the existing in-process execution path.

For local queue testing, run a Redis-compatible server and set `REDIS_URL`, then start both processes:

```bash
SLACK_AGENT_QUEUE_ENABLED=true REDIS_URL=redis://localhost:6379 vp run dev
REDIS_URL=redis://localhost:6379 vp run worker
```

Use a persistent Heroku KVS/Redis plan for production queues. The minimal non-persistent plans are not appropriate for durable Slack work handoff.

Rollback rule:

- App rollback and database rollback are separate operations.
- Do not pair destructive schema changes with routine app deploys.
- If an app release fails, roll back the Heroku release first and evaluate schema rollback separately.

## Development

Format, lint, and type-check TypeScript files:

```bash
vp check
```

Run the explicit TypeScript compiler check:

```bash
vp run typecheck
```

Run TypeScript tests:

```bash
vp test
```

Build/package the TypeScript app:

```bash
vp pack
```

## Repository Layout

```text
src/
  agents/
  domain/
  http/
  infrastructure/
    postgres/
  providers/
  slack/
skills/
tests/
docs/
terraform/
```

The top-level `src/*` directories are the TypeScript application runtime. There is no Python application runtime path.

Architecture references:

- [`docs/architecture.puml`](docs/architecture.puml)
- [`docs/agent-routing-sequence.puml`](docs/agent-routing-sequence.puml)
- [`docs/agent-model-routing.md`](docs/agent-model-routing.md)
- [`docs/agent-skills.md`](docs/agent-skills.md)
- [`docs/salesforce-pdf-workflows.md`](docs/salesforce-pdf-workflows.md)
- [`docs/typescript-parity-validation.md`](docs/typescript-parity-validation.md)

## License

This project is released under the MIT License.
