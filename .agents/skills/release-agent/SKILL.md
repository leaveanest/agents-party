---
name: release-agent
description: "Prepare, validate, and coordinate repository release work for agents-party. Use when Codex is asked to cut, prepare, verify, document, or troubleshoot an application release, deployment handoff, version bump, changelog, migration rollout, or rollback plan."
---

# Release Agent

Coordinate release work for `agents-party` from the actual repository state.
Treat releases as application rollouts for a Slack-native TypeScript service with PostgreSQL,
provider routing, background workers, and Terraform-managed deployment targets.

## Workflow

1. Establish the release scope.
   - Read `AGENTS.md`, the user request, `git status --short`, and the relevant diff or tag range.
   - Identify whether the release includes TypeScript runtime changes, Slack behavior, provider routing, PostgreSQL migrations, queue workers, site/docs, or Terraform.
   - Confirm the target environment and artifact path when it matters: local pack, Heroku dev, AWS ECS, GitHub Pages, or a handoff-only release note.
2. Build the release inventory.
   - Summarize user-visible changes, operational changes, config/env var changes, migration changes, and known risks.
   - Check docs and runbooks when operation, deployment, packaging, or rollout behavior changed.
   - Do not expose secrets, secret names beyond what docs already contain, Terraform state content, Slack tokens, provider keys, or production data.
3. Validate with repository commands.
   - Use `vp` only for JavaScript/TypeScript workflows.
   - Run `vp check`, `vp run typecheck` when the script exists, `vp test`, and `vp pack` when practical.
   - For schema work, include `vp run migrate` against the appropriate local or staging database when the user has provided the target and credentials.
   - For Terraform-only changes, run the relevant `terraform validate` or `terraform plan` from the changed environment directory when credentials and backend access are available.
4. Prepare rollout notes.
   - State exact commit/tag/branch inputs, validation results, required migrations, feature flags or config changes, deployment order, smoke tests, rollback constraints, and owner follow-ups.
   - For Slack-facing changes, include staging Slack verification steps before production rollout.
   - For provider/model routing changes, confirm model registry and capability impacts across providers; do not assume Gemini or OpenAI is the only target.
5. Review before declaring ready.
   - Use the repository `review-agent` skill for a bug-finding pass over release-impacting changes when implementation or release notes changed.
   - If validation could not run, list exactly what remains unproven and why.

## References

- Read `references/release-checklist.md` before preparing or reviewing a non-trivial release.

## Guardrails

- Do not switch from `vp` to npm, pnpm, yarn, or bun for normal repository workflows.
- Do not create release tags, push branches, deploy, run production migrations, or alter Terraform-managed infrastructure unless the user explicitly asks for that action.
- Do not hardcode provider defaults or model ids in release materials beyond reporting what the repository already configures.
- Do not treat database rollback as simple if new writes, OAuth state consumption, provider operation ids, or schema migrations are involved.
