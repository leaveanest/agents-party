# Security Policy

## Reporting a Vulnerability

Do not report security vulnerabilities or suspected credential exposure in a public issue, pull request, discussion, or Slack transcript. If this repository has GitHub private vulnerability reporting enabled, use that channel. Otherwise, contact the maintainers through the public project maintainer channel and request a private disclosure path before sharing details.

When reporting a vulnerability, include only the minimum information needed to understand impact and reproduce the issue. Do not include live credentials, production workspace identifiers, customer data, or secrets in the initial report.

## Secrets and Sensitive Data

Never put these values in public issues, pull requests, logs, screenshots, repro repositories, test fixtures, or copied Slack payloads:

- Slack bot, app, user, signing, OAuth, refresh, or installation tokens.
- Slack OAuth client secrets or app-level credentials.
- LLM provider API keys, access tokens, service account keys, or native provider credentials.
- PostgreSQL, Redis, or other database URLs and passwords.
- Fernet keys, encryption keys, signing keys, session secrets, or webhook secrets.
- Production `.env` files or secret-manager exports.
- Reproduction secrets, customer data, Slack message contents, workspace names, channel IDs, user IDs, or provider request/response payloads that are not explicitly sanitized.

Use placeholders in public material, for example `SLACK_BOT_TOKEN=REDACTED` or `DATABASE_URL=postgres://redacted`.

## Operator Responsibilities

`agents-party` routes Slack-originated requests to external LLM providers through repository-owned provider adapters. Each operator is responsible for understanding and configuring the data handling, retention, logging, training, abuse-monitoring, residency, and deletion terms of every external provider they enable.

Before enabling a provider in a workspace, operators should confirm that provider's current terms and account settings are acceptable for the workspace's Slack data, user expectations, and compliance obligations. This repository cannot override provider-side retention, training, or data handling commitments.

## Supported Versions

The project is pre-1.0. Security fixes are expected to target the default branch unless maintainers announce supported release branches.
