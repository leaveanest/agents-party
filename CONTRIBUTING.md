# Contributing

Thanks for helping improve `agents-party`. This repository is a Slack-native agent routing application built with TypeScript/Node.js, Slack Bolt, repository-owned AI provider adapters, PostgreSQL, and Terraform.

## Development Setup

Use `vp` for JavaScript and TypeScript workflows in this repository. If `vp` is not available, stop and ask for help instead of switching to another package manager.

```sh
vp install
```

## Validation Commands

Run the relevant checks before opening a pull request:

```sh
vp check
vp run typecheck
vp test
vp pack
```

Use `vp run <script>` for package scripts when a direct `vp` command is not available.

## Project Boundaries

Keep changes small and aligned with the existing layered TypeScript application:

- `src/slack/`: Slack Bolt entry points, event ingress, interactions, and Slack SDK usage.
- `src/agents/`: agent orchestration, tool composition, request preparation, and specialist runners.
- `src/domain/`: domain models and business concepts independent from Slack, AI SDK, and database SDK details.
- `src/providers/`: provider routing, model registry, capability matrix, AI SDK adapters, and native provider adapters.
- `src/repositories/`: persistence-facing interfaces and repository logic.
- `src/infrastructure/postgres/`: PostgreSQL-specific persistence implementation and TypeScript migrations.
- `tests/`: automated tests.
- `terraform/`: infrastructure code.
- `docs/`: design notes, migration plans, and operational documentation.

Slack SDK usage should stay under `src/slack/`. Provider-specific SDK usage should stay under `src/providers/`. PostgreSQL access should stay under `src/infrastructure/postgres/`. Domain history should use repository domain models and convert to AI SDK messages only at provider invocation boundaries.

## Pull Request Expectations

- Keep pull requests focused on one issue or closely related change.
- Include tests for behavior changes, especially auth, validation, permissions, persistence, provider routing, Slack retries, and platform boundaries.
- Update docs, runbooks, environment notes, or deployment instructions when a change alters operation, configuration, packaging, or rollout.
- Do not include secrets, production data, copied Slack transcripts, or unsanitized provider payloads in issues, pull requests, fixtures, logs, or screenshots.
- Avoid adding dependencies unless they materially improve correctness, maintainability, safety, or delivery speed.

## Security-Sensitive Contributions

For vulnerabilities or suspected credential exposure, follow `SECURITY.md`. Do not disclose sensitive details publicly before maintainers have a private path to receive and assess the report.
