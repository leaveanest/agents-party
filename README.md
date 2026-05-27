# agents-party

`agents-party` is an open-source Slack-native agent routing application built on a
TypeScript/Node.js runtime. It connects Slack channel and thread workflows to configurable
agent routes, model providers, specialist tools, PostgreSQL-backed state, and Terraform-managed
deployment environments.

The project uses Slack Bolt for JavaScript/TypeScript, repository-owned provider adapters around
the AI SDK, PostgreSQL for persistence, Redis-compatible queues for background handoff, and
Terraform for infrastructure.

## Project Status

`agents-party` is pre-1.0 and under active development. The current TypeScript runtime supports
Slack event ingress, Slack OAuth installation storage, app mention routing, assistant thread
events, active thread follow-up routing, flag-reaction translation commands, workspace/provider
credential storage, Google and Salesforce OAuth flows, Salesforce PDF workflows, media specialists,
and Redis-backed worker processing.

Planned or still-expanding areas include full App Home settings coverage and additional native
provider escape hatches. See the architecture docs under [`docs/`](docs/) for the current boundary
between implemented runtime paths and planned work.

## What It Does

- Routes Slack `app_mention` and assistant-thread events to configured agents.
- Supports workspace, channel, and thread-aware model routing instead of a single hardcoded model.
- Keeps provider routing, model capabilities, and provider-specific behavior in repository-owned
  TypeScript modules.
- Converts repository domain message history to AI SDK messages only at provider invocation
  boundaries.
- Stores Slack installations, OAuth state, workspace routing, and encrypted workspace credentials
  in PostgreSQL.
- Can hand off Slack agent work to Redis-backed workers so Slack acknowledgements are independent
  from provider execution.
- Exposes optional specialist tools for web research, Google Maps, translation, image generation,
  text-to-speech, video generation, and Salesforce PDF workflows.

## Open Source And Operator Notes

This repository is released under the MIT License, but it is an application repository rather than
an npm package intended for registry publication. `package.json` is marked `private` to prevent
accidental package publishing.

Operators are responsible for the Slack workspace, external model providers, OAuth providers,
object storage, deployment platform, and any commercial or data-handling terms that apply to the
services they enable. `agents-party` can route Slack message text, thread context, files, images,
PDFs, audio, and generated media through configured providers.

Before running this app with workspace data:

- Review [`docs/data-processing.md`](docs/data-processing.md).
- Review [`SECURITY.md`](SECURITY.md).
- Review [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
- Confirm the current terms and account settings for each enabled provider.
- Keep production secrets, API keys, OAuth credentials, database URLs, and Terraform state out of
  source control and public issues.

## Architecture

The application is a layered TypeScript modular monolith:

```text
src/
  agents/                  agent orchestration, tool composition, specialist runners
  domain/                  domain models independent from Slack, AI SDK, and database SDK details
  http/                    HTTP server composition
  infrastructure/postgres/ PostgreSQL-specific repositories and migrations
  providers/               provider router, model registry, AI SDK adapters, native adapters
  repositories/            persistence-facing interfaces and repository logic
  slack/                   Slack Bolt ingress, interactions, and Slack SDK usage
tests/                     automated tests
docs/                      architecture notes and operational documentation
terraform/                 infrastructure code
```

Architecture references:

- [`docs/architecture.puml`](docs/architecture.puml)
- [`docs/agent-routing-sequence.puml`](docs/agent-routing-sequence.puml)
- [`docs/agent-model-routing.md`](docs/agent-model-routing.md)
- [`docs/message-history-model.md`](docs/message-history-model.md)
- [`docs/provider-router.md`](docs/provider-router.md)
- [`docs/slack-typescript-ingress.md`](docs/slack-typescript-ingress.md)
- [`docs/typescript-parity-validation.md`](docs/typescript-parity-validation.md)

The Python application runtime has been removed. Repository-local Codex development helpers under
`.agents/skills/` are not part of the app runtime, tests, deploy, or package workflow.

## Quick Start

### Prerequisites

- Node.js 22.x
- `vp` for JavaScript/TypeScript workflows in this repository
- Docker Compose, when using local PostgreSQL or Redis
- A Slack workspace where you can create or install an app, when testing Slack events

If `vp` is not available, install or fix `vp` before continuing. Do not switch to `npm`, `pnpm`,
`yarn`, or `bun` for normal repository workflows.

### 1. Install Dependencies

```bash
vp install
```

### 2. Start Without Slack

This is the fastest local smoke test. Without Slack settings, the server starts and exposes
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

Use the Slack App Manifest template at [`slack-app-manifest.yaml`](slack-app-manifest.yaml). Replace
`agents-party.example.com` with a public HTTPS tunnel URL that forwards to `http://localhost:8000`
before importing the manifest into Slack.

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

## Local Container

This repository includes a root `Dockerfile` for local container checks. Heroku production deploys
use Heroku buildpacks and the root `Procfile` instead of Docker image deployment.

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
the stack.

## Configuration

The TypeScript runtime reads configuration from process environment variables. Use
[`.env.example`](.env.example) as the local reference. Docker Compose reads `.env` automatically;
`vp run ...` commands use variables exported in the current shell.

Core runtime:

```bash
APP_ENV=local
APP_HOST=0.0.0.0
APP_PORT=8000
APP_DEFAULT_LOCALE=ja
```

Slack OAuth and events:

```bash
SLACK_SIGNING_SECRET=...
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_STATE_SECRET=...
SLACK_SCOPES=app_mentions:read,assistant:write,channels:history,channels:join,channels:read,chat:write,files:read,files:write,groups:history,groups:read,im:history,im:read,mpim:history,mpim:read,reactions:read,users:read
SLACK_USER_SCOPES=channels:history,groups:history,im:history,mpim:history,search:read.files,search:read.im,search:read.mpim,search:read.private,search:read.public,search:read.users,users:read,users:read.email
SLACK_EVENTS_PATH=/agents/slack/events
SLACK_INSTALL_PATH=/agents/slack/install
SLACK_OAUTH_REDIRECT_PATH=/agents/slack/oauth_redirect
```

Model and specialist selection:

```bash
AGENT_MODEL=google:gemini-2.5-flash
IMAGE_GENERATION_MODEL=google:gemini-2.5-flash-image
TEXT_TO_SPEECH_MODEL=openai:gpt-4o-mini-tts
VIDEO_GENERATION_MODEL=google:veo-3.1-fast-generate-001
LLM_API_KEY_ENCRYPTION_KEY=...
```

`AGENT_MODEL` is the application bootstrap/fallback model used when Slack routing has not supplied
a thread, channel, or workspace model. Production-like runtimes require `AGENT_MODEL` and fail
closed if it is missing.

When `DATABASE_URL` and `LLM_API_KEY_ENCRYPTION_KEY` are configured, LLM and specialist API keys
are resolved from encrypted rows in the PostgreSQL `workspace_credentials` table by Slack `team_id`.
Do not rely on process-level provider keys for multi-workspace production traffic.

Optional services:

- Redis queue: `REDIS_URL`, `SLACK_AGENT_QUEUE_ENABLED`
- S3-compatible object storage: `OBJECT_STORAGE_*`
- Google OAuth: `GOOGLE_OAUTH_*`, `GOOGLE_TOKEN_ENCRYPTION_KEY`
- Salesforce OAuth: `SALESFORCE_OAUTH_*`, `SALESFORCE_TOKEN_ENCRYPTION_KEY`
- Google Maps local fallback: `GOOGLE_MAPS_API_KEY`

Feature details:

- Slack ingress and localization: [`docs/slack-typescript-ingress.md`](docs/slack-typescript-ingress.md)
- Provider routing and capability checks: [`docs/provider-router.md`](docs/provider-router.md)
- OAuth integrations: [`docs/oauth-typescript-integrations.md`](docs/oauth-typescript-integrations.md)
- Salesforce PDF workflows: [`docs/salesforce-pdf-workflows.md`](docs/salesforce-pdf-workflows.md)

## Worker Queue

Slack AI chat handling can run in-process for local development. To test Redis-backed handoff,
start Redis and run the web and worker processes separately:

```bash
docker compose up -d redis
SLACK_AGENT_QUEUE_ENABLED=true REDIS_URL=redis://localhost:6379 vp run dev
REDIS_URL=redis://localhost:6379 \
DATABASE_URL=postgresql://agents_party:agents_party@localhost:5432/agents_party \
vp run worker
```

When queue mode is enabled, the web process verifies Slack requests, performs lightweight policy
checks, enqueues work, and returns independently from provider execution. The worker consumes the
queue, runs `AgentRunner`, persists thread route state, and posts the final Slack thread reply.

## Deployment

Heroku production deploys use:

- Heroku Node.js and Heroku CLI buildpacks, configured by Terraform
- root `Procfile`
  - `web: node dist/main.mjs`
  - `worker: node dist/worker.mjs`
  - `rss_worker: node dist/rssFeedWorker.mjs`
- Heroku Postgres add-on for `DATABASE_URL`
- Heroku Key-Value Store/Redis add-on for `REDIS_URL`

Terraform for the Heroku app, add-ons, buildpack, non-secret config vars, optional Bucketeer object
storage, and optional web formation lives under [`terraform/environments/dev/`](terraform/environments/dev/).
AWS/Fargate infrastructure lives under [`terraform/environments/aws/`](terraform/environments/aws/).

Secret values are intentionally not managed by Terraform because Terraform state can contain managed
config values. Set Slack, OAuth, encryption, Salesforce, and external API secrets through the
deployment platform or CI secret injection.

Basic Heroku flow:

```bash
cd terraform/environments/dev
export HEROKU_API_KEY=...
terraform init
terraform apply -var-file=terraform.tfvars
```

Set required secrets outside Terraform, then deploy from Git so the Node buildpack reads the
TypeScript package metadata and `Procfile`:

```bash
heroku git:remote -a agents-party-dev
git push heroku main
```

Use a persistent Heroku KVS/Redis plan for production queues. Minimal non-persistent plans are not
appropriate for durable Slack work handoff.

Rollback rule:

- App rollback and database rollback are separate operations.
- Do not pair destructive schema changes with routine app deploys.
- If an app release fails, roll back the Heroku release first and evaluate schema rollback separately.

## Development

Run the normal validation set before opening a pull request:

```bash
vp check
vp run typecheck
vp test
vp pack
```

Use `vp run <script>` for package scripts when a direct `vp` command is not available. Use
[`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution expectations and project boundaries.

## Security

Do not put Slack tokens, OAuth secrets, provider API keys, database URLs, encryption keys,
production `.env` files, Terraform state, copied Slack transcripts, customer data, or unsanitized
provider payloads in public issues, pull requests, logs, screenshots, or fixtures.

Report vulnerabilities through the process in [`SECURITY.md`](SECURITY.md).

## License

This project is released under the MIT License. See [`LICENSE`](LICENSE) for the license text and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for release-facing third-party software, service,
and asset review notes.
