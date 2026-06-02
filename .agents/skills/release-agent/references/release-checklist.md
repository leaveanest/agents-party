# Release Checklist

Use this checklist to prepare, review, or troubleshoot an `agents-party` release.

## Scope Inventory

- Compare the requested release range or local diff with `git status --short`, `git diff --stat`, and the relevant file diffs.
- Identify touched layers:
  - Slack ingress, interactions, App Home, OAuth, or Slack Block Kit under `src/slack/`.
  - Agent orchestration, tools, provider routing, model registry, or AI SDK adapters under `src/agents/` and `src/providers/`.
  - Domain models or repository contracts under `src/domain/` and `src/repositories/`.
  - PostgreSQL schema or repository implementation under `src/infrastructure/postgres/`.
  - Worker, Redis queue, RSS batch, media handoff, or long-running provider behavior.
  - Terraform environments, deployment docs, GitHub Pages site, or public documentation.
- Record user-visible changes separately from operational changes.

## Required Validation

- Run `vp check`.
- Run `vp run typecheck` when `package.json` defines the script.
- Run `vp test`, or clearly state why only targeted tests were run.
- Run `vp pack` for application release readiness when practical.
- Run `vp run site:build` only for site/public-page releases.
- For PostgreSQL changes, run `vp run migrate` against a local or staging database when credentials are available.
- For Terraform changes, run validation from the changed environment directory:
  - `terraform init` when the directory is not initialized.
  - `terraform validate`.
  - `terraform plan -var-file=terraform.tfvars` only when credentials and tfvars are available and the user expects a plan.

## Rollout Notes

Include these fields in release handoff notes when they apply:

- Release identifier: branch, commit, tag, PR, or artifact.
- Deployment target: Heroku dev, AWS ECS, GitHub Pages, local package, or other.
- Deployment order: migrations, web, worker, scheduler, seed/bootstrap, Terraform, or site.
- Required config/env changes, without secret values.
- Database migration status and backup expectation.
- Slack app manifest, OAuth redirect, interactivity, or event subscription changes.
- Provider/model registry impact, including unsupported attachment or capability changes.
- Queue/worker impact and whether existing jobs remain compatible.
- Smoke tests and expected production log signals.
- Rollback path and compatibility constraints.

## Slack Smoke Tests

Use a staging Slack workspace for major runtime or Slack-facing releases:

- `GET /healthz` returns healthy.
- A fresh app mention produces one threaded reply.
- A duplicated Slack event id is suppressed or handled idempotently.
- Active thread follow-up routing respects channel and thread settings.
- A disabled channel does not call the agent runner.
- Slack OAuth install and callback state handling work without replay.
- Provider selection logs include team, channel, thread, provider, and model context without message contents.
- Media, file, image, or generated output flows still produce clear Slack results or clear failures.

## Rollback Risk Review

- Database changes may require restoring a backup or validating compatibility with new writes.
- OAuth state consumption is one-time; rollback cannot safely replay consumed callback state.
- Provider operation ids, generated media handoffs, and model registry additions may not be understood by older code.
- Queue jobs created by new code may be incompatible with older worker code.
- Terraform rollback may require a planned reverse apply and should not be improvised from local state.

## Release Report Shape

Prefer this concise structure:

```text
Release scope:
- ...

Validation:
- vp check: pass/fail/not run
- vp run typecheck: pass/fail/not run
- vp test: pass/fail/not run
- vp pack: pass/fail/not run

Rollout:
- ...

Rollback:
- ...

Open risks:
- ...
```
