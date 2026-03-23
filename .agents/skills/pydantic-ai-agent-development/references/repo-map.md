# Repository Map

Use this map before deciding where new agent code belongs.

## Source Boundaries

- `src/agents_party/agents/`
  - Put agent builders, dependency containers, toolsets, and orchestration helpers here.
- `src/agents_party/slack/`
  - Keep Slack Bolt app setup, commands, actions, and event handlers here.
- `src/agents_party/domain/`
  - Keep domain concepts free from Slack SDK and Firestore SDK details.
- `src/agents_party/repositories/`
  - Put persistence-facing interfaces and repository logic here.
- `src/agents_party/infrastructure/firestore/`
  - Keep Firestore clients and storage implementations here.

## Current Entry Points

- `src/agents_party/main.py`
  - FastAPI app factory and `/slack/events` endpoint.
- `src/agents_party/slack/app.py`
  - Slack Bolt application wiring.
- `src/agents_party/slack/events/`
  - Event handlers such as `app_home_opened` and `app_mention`.
- `src/agents_party/slack/features/`
  - Slash-command and onboarding actions.

## Validation Commands

- `uv run ruff check <path>`
- `uv run ruff format <path>`
- `uv run ty check <path>`
- `uv run pytest <path-or-node>`

## Placement Rules

- Put new agent packages under `src/agents_party/agents/<agent_name>/`.
- Use `src/agents_party/agents/<agent_name>/__init__.py` as the public import surface and re-export the package API from there.
- Start new agents with `models.py` and `runtime.py`; add `executor.py`, `preparer.py`, `prompts.py`, or `messages.py` only when the responsibilities truly split.
- Put shared agent support code in adjacent `src/agents_party/agents/` modules such as reusable runners or request-preparation helpers.
- Route repository-backed side effects through repository abstractions when practical.
- Keep repository-local Codex skills under the repo root `.agents/skills/`.
