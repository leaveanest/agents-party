# agents-party

`agents-party` is a Python Slack application built with FastAPI, Slack Bolt, `pydantic-ai`, and PostgreSQL.
It exposes a Slack-facing `agent_router` that can answer directly or delegate to specialist runtimes for work management, web research, maps, translation, image generation, video generation, and Google OAuth-backed integrations.

## Current Capabilities

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
Heroku production deploys use Heroku buildpacks, the root `Procfile`, and the release phase instead of Docker image deployment.
Both local containers and Heroku production install `ffmpeg`, which is required for transcribing Slack video attachments by extracting an audio track before sending it to Google Cloud Speech-to-Text.
Heroku installs it with the Heroku Active Storage Preview buildpack before the Python buildpack runs.

Build locally if needed:

```bash
docker build -t agents-party .
```

## Configuration

The application reads environment variables from `.env` when present.

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
SLACK_APP_TOKEN=...
SLACK_CLIENT_ID=...
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
DATABASE_URL=postgresql+psycopg://user:password@localhost:5432/agents_party
```

### Heroku database

Production on Heroku uses the `DATABASE_URL` config var created by the Heroku Postgres add-on.
The release phase runs Alembic migrations with the same value:

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
- Heroku Python buildpack, configured by Terraform after the `ffmpeg` buildpack
- root `Procfile`
  - `release: alembic upgrade head`
  - `web: uvicorn agents_party.main:app --host 0.0.0.0 --port $PORT`
- `.python-version` for Heroku uv builds
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

3. Deploy from Git to Heroku so the Python buildpack reads `uv.lock`, `.python-version`, and `Procfile`:

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

Lint changed files:

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

Architecture references:

- [`docs/architecture.puml`](docs/architecture.puml)
- [`docs/agent-routing-sequence.puml`](docs/agent-routing-sequence.puml)
- [`docs/agent-skills.md`](docs/agent-skills.md)

## License

This project is released under the MIT License.
