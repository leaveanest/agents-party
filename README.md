# agents-party

`agents-party` is a Slack-native agent routing application being migrated from Python to TypeScript.
The target runtime is TypeScript/Node.js with Slack Bolt for JavaScript/TypeScript, AI SDK behind repository-owned provider adapters, PostgreSQL, and Terraform.

The current Python implementation remains in the repository only as legacy code during the cutover. The target application runtime does not keep Python as a fallback path.

## TypeScript Runtime Status

The TypeScript runtime currently exposes:

- `GET /healthz`
- `POST /slack/events`
- `GET /slack/install` when Slack OAuth install settings are present
- `GET /slack/oauth_redirect` when Slack OAuth install settings are present

The TypeScript Slack ingress initializes Bolt for JavaScript/TypeScript, validates Slack signatures through Bolt, acknowledges Events API deliveries, and suppresses duplicate event deliveries by Slack `event_id`.
See [`docs/slack-typescript-ingress.md`](docs/slack-typescript-ingress.md) for the current ingress boundary.

The TypeScript domain history model represents text, image, file/PDF, audio, assistant, and tool-result events without storing AI SDK `ModelMessage[]`.
See [`docs/message-history-model.md`](docs/message-history-model.md) for the conversion boundary.

Agent routing, specialist execution, full App Home settings, Google/Salesforce OAuth routes, and provider adapters are planned migration work and are not yet available in the TypeScript runtime.

## Legacy Python Capabilities

The legacy Python application still contains:

- FastAPI entrypoint with:
  - `GET /healthz`
  - `POST /slack/events`
  - `GET /oauth/google/start`
  - `GET /oauth/google/callback`
- Slack event handling for:
  - `app_home_opened`
  - `app_mention`
  - `message`
  - `reaction_added`
- Mention-based agent routing with full Slack thread context
- Follow-up auto-replies in active assistant threads stored in PostgreSQL
- Reaction-based translation for country-flag emoji such as `:flag-jp:` and `:flag-us:`
- Google OAuth start and callback flow with encrypted token storage in PostgreSQL

## Specialist Runtimes

The Slack router can delegate to these specialist runtimes:

- `work_manager`
  - capture and update work items backed by PostgreSQL
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

The router may combine multiple text specialists in one response.
Media specialists are terminal for a run: at most one image or video generation step is used, and the resulting file is uploaded back into Slack.

## Built-in Agent Skills

Repository-managed built-in skills live under [`skills/`](skills/) and are loaded by [`src/agents_party/agents/skills/catalog.py`](src/agents_party/agents/skills/catalog.py).

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

Install TypeScript dependencies:

```bash
vp install
```

Run the TypeScript app locally:

```bash
vp run dev
```

The TypeScript runtime exposes:

- `GET /healthz`
- `POST /slack/events`
- `GET /slack/install` when Slack OAuth install settings are present
- `GET /slack/oauth_redirect` when Slack OAuth install settings are present

Validate the TypeScript workspace:

```bash
vp check
vp test
vp pack
```

### Legacy Python Setup

Use this only while working on legacy Python code before it is removed.

Install dependencies:

```bash
uv sync
```

Apply database migrations:

```bash
uv run alembic upgrade head
```

Run the app locally:

```bash
uv run agents-party
```

## Local Container

This repository includes a root `Dockerfile` for local container checks only.
Heroku production deploys use Heroku buildpacks and the root `Procfile` instead of Docker image deployment.
Both local containers and Heroku production install `ffmpeg`, which is required for transcribing Slack video attachments by extracting an audio track before sending it to Google Cloud Speech-to-Text.
Heroku installs it with the Heroku Active Storage Preview buildpack before the Node buildpack runs.

Build locally if needed:

```bash
docker build -t agents-party .
```

## Configuration

The TypeScript runtime reads configuration from process environment variables.
Legacy Python code still reads environment variables from `.env` when present.

### Core runtime

```bash
APP_ENV=local
APP_HOST=0.0.0.0
APP_PORT=8000
DEFAULT_TIMEZONE=UTC
GOOGLE_CLOUD_PROJECT=...
GOOGLE_CLOUD_LOCATION=global
GOOGLE_CLOUD_SPEECH_LOCATION=us
GOOGLE_CLOUD_TRANSCRIPTION_MODEL=chirp_3
GOOGLE_CLOUD_TRANSCRIPTION_LANGUAGE_CODES=["ja-JP"]
GOOGLE_CLOUD_TRANSCRIPTION_STAGING_BUCKET=...
```

### Slack

Use a static bot token locally, or provide `SLACK_CLIENT_ID` together with database settings when using the installation store:

```bash
SLACK_BOT_TOKEN=...
SLACK_SIGNING_SECRET=...
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_STATE_SECRET=...
SLACK_SCOPES=app_mentions:read,channels:history,chat:write,groups:history,im:history,mpim:history,reactions:read,users:read,views:write
SLACK_USER_SCOPES=
SLACK_EVENTS_PATH=/slack/events
SLACK_INSTALL_PATH=/slack/install
SLACK_OAUTH_REDIRECT_PATH=/slack/oauth_redirect
AGENT_SELECTOR_MODEL=google-gla:gemini-3-flash-preview
```

### Specialists

```bash
WORK_MANAGER_MODEL=google-gla:gemini-3-flash-preview
WEB_RESEARCH_MODEL=google-vertex:gemini-3-flash-preview
GOOGLE_MAPS_API_KEY=...
GOOGLE_MAPS_MODEL=google-vertex:gemini-3-flash-preview
GOOGLE_MAPS_LANGUAGE_CODE=ja
GOOGLE_MAPS_REGION_CODE=JP
IMAGE_GENERATION_MODEL=gemini-2.5-flash-image
VIDEO_GENERATION_MODEL=veo-3.1-fast-generate-001
VIDEO_GENERATION_PROMPT_MODEL=gemini-2.5-flash
```

### Local database

Use a direct PostgreSQL URL for local development and one-off verification:

```bash
DATABASE_URL=postgresql://user:password@localhost:5432/agents_party
```

### Heroku database

Production on Heroku uses the `DATABASE_URL` config var created by the Heroku Postgres add-on.
Legacy Python deployments used Alembic migrations with the same value. TypeScript-managed migrations are planned for the persistence cutover.

```bash
DATABASE_URL=postgres://...
```

For local development and one-off verification, use a direct PostgreSQL URL with the SQLAlchemy driver prefix:

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

## Deployment

Heroku production deploys use:

- Heroku Active Storage Preview buildpack for the `ffmpeg` runtime binary
- Heroku Node.js buildpack, configured by Terraform after the `ffmpeg` buildpack
- root `Procfile`
  - `web: node dist/main.mjs`
- `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml` for the TypeScript runtime
- Heroku Postgres add-on for `DATABASE_URL`
- Heroku Managed Inference and Agents add-on for `INFERENCE_KEY` and `INFERENCE_URL`

Terraform for the Heroku app, add-ons, buildpack, non-secret config vars, and optional web formation lives under `terraform/environments/dev/`.

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
  SLACK_BOT_TOKEN=... \
  SLACK_SIGNING_SECRET=... \
  GOOGLE_OAUTH_CLIENT_SECRET=... \
  GOOGLE_OAUTH_CONTEXT_SIGNING_SECRET=... \
  GOOGLE_TOKEN_ENCRYPTION_KEY=... \
  -a agents-party-dev
```

3. Deploy from Git to Heroku so the Node buildpack reads the TypeScript package metadata and `Procfile`:

```bash
heroku git:remote -a agents-party-dev
git push heroku main
```

4. After the first release has created the `web` process type, set `manage_web_formation = true` in `terraform.tfvars` and re-apply Terraform if you want Terraform to own web dyno quantity and size.

Rollback rule:

- App rollback and database rollback are separate operations.
- Do not pair destructive Alembic revisions with routine app deploys.
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

### Legacy Python Development

Use these only while working on Python code before it is removed.

Lint changed Python files:

```bash
uv run ruff check <path>
```

Format changed files:

```bash
uv run ruff format <path>
```

Type-check changed files:

```bash
uv run ty check <path>
```

Run tests:

```bash
uv run pytest
```

Create a new migration revision:

```bash
uv run alembic revision --autogenerate -m "describe change"
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
  repositories/
  slack/
src/agents_party/
  agents/
  domain/
  google_auth/
  infrastructure/
  repositories/
  slack/
skills/
tests/
docs/
terraform/
```

The top-level `src/*` directories are the TypeScript target structure. `src/agents_party/` is the legacy Python implementation awaiting removal during the TypeScript cutover.

Architecture references:

- [`docs/architecture.puml`](docs/architecture.puml)
- [`docs/agent-routing-sequence.puml`](docs/agent-routing-sequence.puml)
- [`docs/agent-skills.md`](docs/agent-skills.md)

## License

This project is released under the MIT License.
