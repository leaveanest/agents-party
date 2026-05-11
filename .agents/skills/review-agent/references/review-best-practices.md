# Review Best Practices

Checked against public sources on 2026-03-25.

## Core Principles

- Review for code health, not perfection.
  Google’s reviewer guide says reviewers should approve once a change clearly improves overall code health, even if it is not perfect. That maps well to this repository because over-blocking slows iteration without improving outcomes.
- Prefer technical reasoning over personal preference.
  Google’s guidance explicitly favors facts, maintainability, and consistency over opinion. Treat style-only comments as low priority unless the repository already mandates them.
- Keep reviews fast enough to preserve team throughput.
  Google recommends responding quickly, ideally within one business day when not in a focused task. For this repository, that means reviewing shortly after implementation rather than batching review until much later.

## What To Check First

- Design and repository boundaries.
  Start with whether the change belongs in the current layer and package. In `agents-party`, this especially means:
  - Slack SDK usage stays in `src/slack/`
  - Provider-specific SDK usage stays in `src/providers/`
  - PostgreSQL SDK usage stays in `src/infrastructure/postgres/`
  - Domain models stay independent from Slack, AI SDK, and database SDK details
- Functionality and regressions.
  Check whether the code does what the author intended, whether edge cases are handled, and whether user-visible changes were validated. Google also calls out concurrency and race-condition review as especially important because they are easy to miss in execution-only testing.
- Complexity and over-engineering.
  Flag code that is harder to understand than necessary, or abstractions added for hypothetical future needs instead of the current problem.
- Tests and docs.
  Ask for tests when behavior changed and for docs when setup, configuration, or usage changed. In this repository that includes `.env` expectations, OAuth settings, CLI workflows, and README or `docs/` updates when public behavior moves.
- Security and operational safety.
  GitHub’s code reviewer guidance emphasizes secrets, authentication, authorization, input validation, performance red flags, and actionable feedback. Apply that here to credentials, token handling, secret storage, external HTTP calls, and error handling.

## How To Write Findings

- Be specific and actionable.
  GitHub’s guidance recommends concrete feedback that explains the “why.” Avoid vague statements like “this seems off.”
- Explain impact, not just preference.
  Google’s reviewer comments guide recommends explaining why a change harms code health or behavior. A strong finding ties the code to a bug, regression, security gap, or maintainability risk.
- Keep the tone factual and courteous.
  Google recommends commenting on the code, not the developer, and balancing explicit guidance with leaving room for the author to choose the exact fix.
- Narrow scope explicitly when needed.
  Google recommends stating what part of a change you reviewed if you did not review everything. If a review is intentionally partial, say so.

## Repo-Specific Review Heuristics

- Treat missing validation output as a review gap when TypeScript runtime files changed. This repository expects `vp check`, `vp run typecheck`, targeted or full `vp test`, and `vp pack` when practical.
- Treat hardcoded model defaults that violate repository policy as findings. New default agent models should not hardcode OpenAI model ids in this repository.
- Treat leaked secrets, plaintext tokens, or OAuth callback/state mistakes as high-severity findings.
- Treat shared-config changes without broader validation as a risk to call out, even if not a hard failure yet.

## Sources

- [Google Engineering Practices: The Standard of Code Review](https://google.github.io/eng-practices/review/reviewer/standard.html)
- [Google Engineering Practices: What to look for in a code review](https://google.github.io/eng-practices/review/reviewer/looking-for.html)
- [Google Engineering Practices: How to write code review comments](https://google.github.io/eng-practices/review/reviewer/comments.html)
- [Google Engineering Practices: Speed of Code Reviews](https://google.github.io/eng-practices/review/reviewer/speed.html)
- [GitHub Docs: Code reviewer custom instructions](https://docs.github.com/en/copilot/tutorials/customization-library/custom-instructions/code-reviewer)
