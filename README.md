# agents-party

`agents-party` is a Python Slack application built with FastAPI, Slack Bolt, `pydantic-ai`, and PostgreSQL.
It is intended to orchestrate agent-based workflows inside Slack.

## Stack

- Python 3.12
- `uv` for dependency management and command execution
- `ruff` for linting and formatting
- `ty` for type checking
- FastAPI for the web application entrypoint
- Slack Bolt for Slack event handling
- `pydantic-ai` and `pydantic-ai-skills` for agent behavior
- PostgreSQL for persistence
- SQLModel for relational table models
- Alembic for schema migrations
- Terraform for infrastructure layout

## Current Status

The repository currently includes:

- a FastAPI app entrypoint
- a Slack events endpoint at `/slack/events`
- async Slack Bolt handlers
- basic handlers for:
  - `app_home_opened`
  - `app_mention`

The agent that responds to an `app_mention` is intended to be selected by workspace, channel,
and thread settings. The repository may contain multiple agent implementations even though the
Slack app itself is a single app.

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

## Codex Skills

Repository-local Codex skills live under `.agents/skills/`.

- `agent-skill-authoring`
  - guidance and helper scripts for creating Codex skills in this repository
- `pydantic-ai-agent-development`
  - guidance and helper scripts for adding `pydantic-ai` agents in this repository

## Environment Variables

### Local development

Use a direct PostgreSQL URL for local development and one-off verification:

```bash
SLACK_BOT_TOKEN=...
SLACK_SIGNING_SECRET=...
DATABASE_URL=postgresql+psycopg://user:password@localhost:5432/agents_party
```

### Cloud Run with Cloud SQL

Production on Cloud Run uses the Cloud SQL Python Connector with IAM database authentication.
Do not set `DATABASE_URL` in Cloud Run. Set the following instead:

```bash
SLACK_BOT_TOKEN=...
SLACK_SIGNING_SECRET=...
CLOUD_SQL_INSTANCE_CONNECTION_NAME=project:region:instance
CLOUD_SQL_DATABASE=agents_party
CLOUD_SQL_IAM_DB_USER=agents-party-runtime@project-id.iam
CLOUD_SQL_IP_TYPE=PUBLIC
```

The application reads environment variables from `.env` if present. `DATABASE_URL`
always wins when both modes are configured, which is intended for local overrides only.

## Deployment

Terraform for the initial Cloud Run + Cloud SQL wiring lives under
`terraform/environments/dev/`.

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

Create a new migration revision:

```bash
uv run alembic revision --autogenerate -m "describe change"
```

## Repository Layout

```text
src/agents_party/
  agents/
  domain/
  infrastructure/postgres/
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
