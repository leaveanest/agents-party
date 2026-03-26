# agents-party

`agents-party` is a Python Slack application built with FastAPI, Slack Bolt, `pydantic-ai`, and Firestore.
It is intended to orchestrate agent-based workflows inside Slack.

## Stack

- Python 3.12
- `uv` for dependency management and command execution
- `ruff` for linting and formatting
- `ty` for type checking
- FastAPI for the web application entrypoint
- Slack Bolt for Slack event handling
- `pydantic-ai` and `pydantic-ai-skills` for agent behavior
- Firestore for persistence
- Terraform for infrastructure layout

## Current Status

The repository currently includes:

- a FastAPI app entrypoint
- a Slack events endpoint at `/slack/events`
- async Slack Bolt handlers
- basic handlers for:
  - `app_home_opened`
  - `reaction_added`

The current Slack translation flow is triggered by country flag reactions such as
`:flag-jp:` or `:flag-us:` on Slack messages. The app reads the reacted message and
posts the translation into that message's thread.

## Setup

Install dependencies:

```bash
uv sync
```

Run the app locally:

```bash
uv run agents-party
```

## Codex Skills

Repository-local Codex skills live under `.agents/skills/`.

- `agent-skill-authoring`
  - guidance and helper scripts for creating Codex skills in this repository
- `pydantic-ai-agent-development`
  - guidance and helper scripts for adding `pydantic-ai` agents in this repository
- `review-agent`
  - guidance for post-implementation code review focused on bugs, regressions, and boundary violations

## Environment Variables

Set the following environment variables before using Slack integration:

```bash
SLACK_BOT_TOKEN=...
SLACK_SIGNING_SECRET=...
GOOGLE_CLOUD_PROJECT=...
FIRESTORE_DATABASE=(default)
```

The application reads environment variables from `.env` if present.

## Development

Lint:

```bash
uv run ruff check src tests
```

Format:

```bash
uv run ruff format src tests
```

Type-check:

```bash
uv run ty check src
```

Run tests:

```bash
uv run pytest
```

Run tests with coverage:

```bash
uv run pytest --cov=agents_party --cov-report=term-missing
```

## Repository Layout

```text
src/agents_party/
  agents/
  domain/
  infrastructure/firestore/
  repositories/
  slack/
terraform/
  environments/
  modules/
tests/
docs/
```

## License

This project is released under the MIT License.
