# agents-party

`agents-party` is a Python Slack application built with FastAPI, Slack Bolt, `pydantic-ai`, and Firestore.
It exposes a public Slack-facing `agent_router` that can answer directly or delegate to specialist runtimes for work management, web research, maps, translation, image generation, and video generation.

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
- Follow-up auto-replies in active assistant threads stored in Firestore
- Reaction-based translation for country-flag emoji such as `:flag-jp:` and `:flag-us:`
- Google OAuth start and callback flow with encrypted token storage in Firestore

## Specialist Runtimes

The Slack router can delegate to these specialist runtimes:

- `work_manager`
  - capture and update work items backed by Firestore
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

## Setup

Install dependencies:

```bash
uv sync
```

Run the app locally:

```bash
uv run agents-party
```

## Configuration

The application reads environment variables from `.env` when present.

Core runtime:

```bash
APP_ENV=local
APP_HOST=0.0.0.0
APP_PORT=8000
DEFAULT_TIMEZONE=UTC
GOOGLE_CLOUD_PROJECT=...
GOOGLE_CLOUD_LOCATION=global
FIRESTORE_DATABASE=(default)
```

Slack:

```bash
SLACK_BOT_TOKEN=...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=...
AGENT_SELECTOR_MODEL=google-gla:gemini-3-flash-preview
```

Specialists:

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

Google OAuth:

```bash
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_BASE_URL=https://...
GOOGLE_OAUTH_CONTEXT_SIGNING_SECRET=...
GOOGLE_TOKEN_ENCRYPTION_KEY=...
```

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
