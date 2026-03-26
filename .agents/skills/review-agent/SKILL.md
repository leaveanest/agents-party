---
name: review-agent
description: "Review code changes in this repository after implementation. Use when Codex needs to inspect a diff or local changes for bugs, regressions, security issues, missing tests, or repository-boundary violations before considering work complete."
---

# Review Agent

Review completed changes here with a bug-finding mindset.
Start from the actual diff, keep the review scoped and actionable, and optimize for catching correctness, regression, and maintainability risks before the task is treated as done.

## Workflow

1. Establish the review scope from the real change.
   - Read `AGENTS.md` and the user request for repository-specific constraints.
   - Inspect `git status --short`, `git diff --stat`, and the relevant diffs before forming conclusions.
   - Review changed files first and pull surrounding code only when context is needed.
2. Prioritize the highest-signal risks.
   - Look first for correctness bugs, regressions, security issues, missing validation, and data integrity problems.
   - Check repository-boundary violations: Slack SDK must stay under `src/agents_party/slack/`, Firestore SDK under `src/agents_party/infrastructure/firestore/`, and domain models must stay independent from Slack and Firestore.
   - Treat missing or weak tests as findings when the change alters behavior, contracts, or failure handling.
3. Validate findings with focused checks.
   - Run targeted non-mutating checks when they strengthen a claim, such as `uv run pytest <paths>`, `uv run ruff check <paths>`, or `uv run ty check <paths>`.
   - Prefer file-scoped validation first; widen scope only when shared config, imports, or cross-package behavior changed.
4. Report like a reviewer, not an implementer.
   - Lead with findings ordered by severity and include file and line references.
   - Explain the impact and the reason the issue matters.
   - Keep summaries brief and secondary. If there are no findings, say so explicitly and note residual risks or testing gaps.

## References

- Read `references/review-best-practices.md` for the current review heuristics and the web-backed sources they were derived from.

## Guardrails

- Do not block on perfection or personal style preferences that do not affect code health.
- Do not rewrite code while reviewing unless the task explicitly asks for fixes in the same turn.
- Do not comment on unrelated dirty-worktree files unless they materially affect the reviewed change.
- Do not give a blanket approval without reviewing the changed code or explicitly stating a narrowed review scope.
