# TypeScript Full Replacement Plan

Status: Accepted and implemented through the OSA-6 child issue sequence.

## Goal

Replace the former Python Slack application with a TypeScript/Node.js application without keeping a Python production fallback path.

The target runtime is:

- Slack Bolt for JavaScript/TypeScript for Slack ingress and interaction handling.
- Repository-owned TypeScript agent orchestration under `src/agents/`.
- AI SDK as the common provider invocation lane where it fits.
- Repository-owned provider routing, model registry, capability checks, and native provider escape hatches under `src/providers/`.
- Repository domain message history converted to AI SDK messages only at provider boundaries.
- PostgreSQL persistence and schema migration logic implemented in TypeScript.
- Node/TypeScript deployment through the root `Procfile`, package scripts, and Heroku Node.js buildpack.

## Non-Goals

- Do not keep the Python application as a runtime fallback.
- Do not store AI SDK `ModelMessage[]` as the repository message history format.
- Do not push provider-specific SDK branches into Slack handlers or domain models.
- Do not use `uv`, `pyproject.toml`, Alembic, or Python test commands for the application workflow.

## Sequencing

The replacement was split into child issues so each boundary could be reviewed and merged independently:

| Area                                                             | Issue             |
| ---------------------------------------------------------------- | ----------------- |
| TypeScript app scaffold, Node startup, and vp workflow           | OSA-7             |
| Slack ingress through Bolt for JavaScript/TypeScript             | OSA-8             |
| Domain message and attachment history model                      | OSA-9             |
| ProviderRouter, model registry, and capability matrix            | OSA-10            |
| AI SDK common adapter lane                                       | OSA-11            |
| Native provider escape hatches                                   | OSA-12 and OSA-19 |
| PostgreSQL repositories and TypeScript migrations                | OSA-13            |
| TypeScript AgentRunner and specialist runtimes                   | OSA-14            |
| OAuth and external integration flows                             | OSA-15            |
| Parity, observability, rollback constraints, and review evidence | OSA-17            |
| Destructive Python runtime removal                               | OSA-16            |

## Architecture Boundaries

- Slack SDK usage stays inside `src/slack/`.
- Provider SDK usage stays inside `src/providers/`.
- PostgreSQL SDK usage stays inside `src/infrastructure/postgres/`.
- Domain models stay independent from Slack, AI SDK, provider SDKs, and database SDK details.
- Agent orchestration composes domain history, routing decisions, specialist runtimes, and provider calls from `src/agents/`.

## Cutover Policy

The cutover is destructive at the application-runtime level. After OSA-16, rollback means restoring an older deployment artifact and validating database compatibility or restoring a database backup. The repository does not retain a Python service, Python dependency workflow, or Python test suite for the removed application.

Retained `.agents/skills/*/scripts/*.py` files are Codex development helper scripts only. They are not application runtime, deployment, package, or test paths.

## Validation Policy

Use the TypeScript workflow:

- `vp check`
- `vp run typecheck`
- `vp test`
- `vp pack`

For Terraform-only changes, also run `terraform -chdir=terraform/environments/dev fmt -check`.
