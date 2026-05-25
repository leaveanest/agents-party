# Third-Party Notices

This project is released under the MIT License. This notice summarizes the third-party software,
services, and assets that operators should review before publishing, deploying, or redistributing
`agents-party`.

This file is a practical release artifact, not a complete legal review. Verify dependency licenses
from the current lockfile and package metadata before each public release.

## Runtime Dependencies

The application runtime depends on npm packages declared in `package.json` and locked in
`pnpm-lock.yaml`. Major dependency groups include:

- Slack SDK packages: `@slack/bolt`, `@slack/oauth`, and `@slack/web-api`
- AI SDK provider packages and `ai`
- Google Gen AI SDK: `@google/genai`
- PostgreSQL, Redis, and queue libraries: `pg`, `ioredis`, and `bullmq`
- PDF rendering packages: `@pdfme/common`, `@pdfme/generator`, and `@pdfme/schemas`
- Utility libraries: `fast-xml-parser`, `i18next`, `sharp`, and `zod`

Before release, inspect direct and transitive dependency licenses from the installed dependency tree
and lockfile. If a package introduces a notice, attribution, source-availability, or redistribution
obligation, include that obligation with the release artifact.

## External Services

`agents-party` can integrate with external services depending on operator configuration:

- Slack Events API, Web API, OAuth, assistant surfaces, files, search, and MCP token-backed calls
- LLM and media providers through AI SDK adapters and native provider adapters
- Google services, including Google OAuth, Google Calendar, Google Maps, Google Speech-to-Text,
  Google Gen AI, and Vertex AI
- Salesforce OAuth and Salesforce APIs
- SORACOM APIs
- PostgreSQL, Redis-compatible queues, object storage, Heroku, and AWS managed services

Service terms, data-retention settings, model-training controls, residency options, rate limits,
and commercial restrictions are provider-specific and can change. Operators are responsible for
reviewing the current terms and account settings for each enabled service before using the app with
workspace data.

## Bundled Assets

The repository includes `assets/slack/agents-party-app-icon-friendly-flat.png` for the Slack app
icon. Treat it as a project asset for this repository. If the asset is reused outside this project or
distributed independently, confirm its provenance and reuse rights first.

## Release Checklist

- Confirm the repository license is still correct for the intended release.
- Review direct and transitive dependency licenses from the current lockfile.
- Confirm bundled assets have known provenance and redistribution rights.
- Confirm external provider terms for every provider enabled in the target deployment.
- Keep production secrets, provider keys, OAuth credentials, database URLs, Terraform state, and
  local `.env` files out of source control and release archives.
