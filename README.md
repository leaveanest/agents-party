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

## Cloud Run Container

This repository includes a root `Dockerfile` for Cloud Run deployments.
The container installs `ffmpeg`, which is required for transcribing Slack video attachments by extracting an audio track before sending it to Google Cloud Speech-to-Text.

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

### Cloud Run with Cloud SQL

Production on Cloud Run uses the Cloud SQL Python Connector with IAM database authentication.
Do not set `DATABASE_URL` in Cloud Run. Set the following instead:

```bash
CLOUD_SQL_INSTANCE_CONNECTION_NAME=project:region:instance
CLOUD_SQL_DATABASE=agents_party
CLOUD_SQL_IAM_DB_USER=agents-party-runtime@project-id.iam
CLOUD_SQL_IP_TYPE=PUBLIC
```

`DATABASE_URL` always wins when both modes are configured, which is intended for local overrides only.

### Google OAuth

```bash
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_BASE_URL=https://...
GOOGLE_OAUTH_CONTEXT_SIGNING_SECRET=...
GOOGLE_TOKEN_ENCRYPTION_KEY=...
```

## Deployment

Terraform for the initial Cloud Run + Cloud SQL wiring lives under `terraform/environments/dev/`.

1. Apply infrastructure:

```bash
cd terraform/environments/dev
terraform init
terraform apply -var-file=terraform.tfvars
```

2. Run the Cloud Run migration job before shifting traffic:

```bash
gcloud run jobs execute agents-party-migrate --region=asia-northeast1 --wait
```

3. Deploy or update the Cloud Run service image, then point traffic to the latest revision.

Rollback rule:

- App rollback and database rollback are separate operations.
- Do not pair destructive Alembic revisions with routine app deploys.
- If an app release fails, roll back the Cloud Run revision first and evaluate schema rollback separately.

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
