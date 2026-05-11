# AGENTS.md

This repository is `agents-party`, a Slack-native agent routing application.
It is being migrated from the current Python implementation to a TypeScript/Node.js application.
The target stack is Slack Bolt for JavaScript/TypeScript, AI SDK behind repository-owned provider adapters, PostgreSQL for persistence, and Terraform for infrastructure.

The Python implementation is legacy during this migration and is scheduled for removal. Do not add new production Python app paths unless the user explicitly changes that direction.

## Core Rules

- Use `vp` for JavaScript/TypeScript runtime, dependency, lint, format, type-check, test, and build workflows.
- Use TypeScript for new application runtime code.
- Use Slack Bolt for JavaScript/TypeScript for Slack event ingress and interactions.
- Use AI SDK as the common LLM invocation lane, not as the whole application architecture.
- Keep provider routing, model registry, provider capabilities, and native provider escape hatches in repository-owned TypeScript modules.
- Do not store AI SDK `ModelMessage[]` as the domain message history format. Store repository domain models and convert to AI SDK messages only at provider invocation boundaries.
- Support multiple LLM providers. Do not assume Gemini is the only target provider.
- Do not hardcode OpenAI model ids as defaults in agent configuration.
- Preserve existing Python only when the current issue does not own its deletion. Treat it as legacy code awaiting cutover, not as a fallback architecture.
- Keep changes small and local. Avoid speculative repo-wide rewrites.

## Required Commands

- Install/sync dependencies with `vp install`
- Add runtime dependencies with `vp add ...`
- Add dev dependencies with `vp add -D ...`
- Format, lint, and type-check with `vp check`
- Run the explicit TypeScript compiler check with `vp run typecheck` when the project defines that script
- Run TypeScript tests with `vp test`
- Build/package the TypeScript app with `vp build` or `vp pack`, according to the configured project shape
- Use `vp run <script>` for package scripts when a direct `vp` command is not available

If `vp` is missing from the shell, stop and report it instead of switching package managers.
Do not use `npm`, `pnpm`, `yarn`, or `bun` directly for normal project workflows unless the user explicitly asks for a fallback.

### Legacy Python Commands

Use these only when touching legacy Python code before it is removed:

- Sync legacy Python environment with `uv sync`
- Lint changed Python files with `uv run ruff check <path>`
- Format changed Python files with `uv run ruff format <path>`
- Type-check changed Python files with `uv run ty check <path>`

Do not use `pip`, `poetry`, or ad-hoc virtualenv workflows.

## Repository Structure

Target TypeScript structure:

- `src/slack/`: Slack-specific entry points, events, feature handlers, and Slack SDK usage
- `src/agents/`: agent orchestration, tool composition, request preparation, and specialist runners
- `src/domain/`: domain models and business concepts independent from Slack, AI SDK, and database SDK details
- `src/providers/`: provider router, model registry, capability matrix, AI SDK adapters, and native provider adapters
- `src/repositories/`: persistence-facing interfaces and repository logic
- `src/infrastructure/postgres/`: PostgreSQL-specific persistence implementation
- `tests/`: automated tests
- `terraform/`: infrastructure code, separated from application code
- `docs/`: design notes, migration plans, and operational documentation

Legacy Python structure while migration is in progress:

- `src/agents_party/`: current Python implementation awaiting TypeScript replacement
- `alembic/`: current Python/Alembic migration history awaiting TypeScript migration cutover
- `pyproject.toml` and `uv.lock`: legacy Python dependency workflow until Python removal

## Architecture Boundaries

- Keep Slack SDK usage inside `src/slack/`.
- Keep AI SDK types at provider adapter boundaries; do not leak them into Slack handlers or domain history.
- Keep provider-specific SDK usage inside `src/providers/` adapter implementations.
- Prefer repositories as the boundary between domain logic and persistence implementation.
- Keep PostgreSQL database access inside `src/infrastructure/postgres/`.
- Put agent orchestration and skill composition in `src/agents/`.
- Use a layered modular monolith unless the user explicitly asks for another application shape.
- Keep UI/application/domain/infrastructure boundaries explicit when a change crosses them.
- New relational schema changes should be planned for the TypeScript migration stack, not new Alembic work, unless the user explicitly asks for a legacy Python change.

## Full-Stack Implementation Expectations

- Start from the user-facing Slack flow and work inward through handlers, application logic, provider calls, repositories, and persistence.
- Prefer the existing repository patterns and the agreed migration architecture over introducing a new stack shape.
- Validate inputs at the server or privileged boundary. Never rely on client-only validation or Slack payload shape alone.
- Enforce authorization explicitly and deny by default where workspace, channel, user, OAuth, or provider credentials are involved.
- Treat Slack retries, duplicate deliveries, background work, provider timeouts, and idempotency as correctness concerns.
- Make write paths and provider failures observable enough to debug incidents.
- Prefer additive, reviewable data changes and surface backfills, dual reads/writes, or destructive migration risks explicitly.
- Verify the main user-visible path on the real target surface when the change affects Slack behavior.

## Documentation Conventions

- Store architecture diagrams under `docs/` and prefer PlantUML (`.puml`) unless the user asks for a different format.
- For architecture diagrams, prioritize system-to-system relationships over library-level dependencies.
- When documenting Google Cloud architecture, show managed services explicitly and keep Google Cloud internals more detailed than external systems when that helps explain the design.
- Treat Vertex AI as a Google Cloud service inside the Google Cloud boundary, not as an external provider.
- Do not enumerate Secret Manager contents or individual secret names in repository documentation unless the user explicitly asks for that level of detail.
- If a diagram includes infrastructure that is operationally assumed but not yet codified in `terraform/` or deployment config, label that assumption clearly.
- Update docs, runbooks, env var notes, and deployment instructions when a change alters operation, configuration, packaging, or rollout.

## Validation Expectations

- After editing TypeScript files, run `vp check`, `vp run typecheck` when available, `vp test`, and the relevant `vp build` or `vp pack` command when practical.
- After editing legacy Python files, run the legacy Python checks listed above.
- Run project-wide validation when changes affect shared configuration, import structure, package workflow, provider contracts, or multiple packages.
- Prefer targeted validation first because it keeps feedback tight.
- Include negative-path tests when changing auth, validation, permissions, persistence, provider routing, Slack retries, or platform boundaries.
- After implementation work, perform a review step before considering the task complete.
- Use the repository `review-agent` for that review step when the current session allows sub-agent delegation.
- If validation cannot be run locally, state exactly what remains unproven.

## Dependency Policy

- Prefer existing dependencies and platform primitives when they solve the problem well enough.
- Add a new dependency only when it meaningfully improves correctness, safety, maintainability, or delivery speed.
- Avoid overlapping libraries that create competing ways to solve the same problem inside one repository.
- When introducing a dependency, consider maintenance health, ecosystem fit, security posture, and how hard it will be to remove later.

## When Unsure

- Ask a short clarifying question instead of making large structural assumptions.
- If a subtree needs specialized rules later, add a more specific `AGENTS.md` in that directory rather than bloating this file.
