# Data Processing

This document summarizes the data processed by `agents-party` so operators can review the app before
publishing, deploying, or enabling features for a Slack workspace.

Provider-side retention, training, logging, residency, and deletion behavior depends on the selected
provider, account, region, feature, and operator configuration. Review each provider's current terms
and admin settings before enabling it for workspace data.

## Slack Data

The app receives Slack Events API deliveries and interaction payloads needed to route agent requests,
App Home settings, OAuth flows, and feature controls. Depending on the feature, the app can process:

- workspace, enterprise, channel, thread, message, user, and timestamp identifiers
- message text and thread context
- file metadata for supported Slack attachments
- image bytes for supported image attachments
- audio bytes and derived transcripts for supported audio attachments
- Slack OAuth installation data and invoking-user tokens for features that require user-scoped Slack
  access

Slack identifiers are scoped by workspace `team_id`. Do not treat channel, user, thread, message, or
view identifiers as globally unique without the owning Slack workspace.

## Provider Invocation

At model invocation boundaries, repository domain history is converted to provider request messages.
The app can send message text, thread context, supported attachment bytes, transcripts, tool inputs,
and tool results to the selected model or specialist provider when required for the user request.

AI SDK message types are not the repository's domain history format. They are produced at provider
invocation boundaries and mapped back into repository-owned result types.

## Transient Attachment Handling

Slack image and audio attachments are handled as transient request context:

- supported image files are downloaded from Slack private file URLs with the bot token, optionally
  resized, and passed to the current agent invocation
- supported audio files are downloaded from Slack private file URLs with the bot token, transcribed,
  and passed to the current agent invocation as transcript text
- queued worker paths re-read Slack context and re-download attachment bytes instead of storing those
  bytes in Redis job payloads
- unsupported or oversized attachments are rejected with Slack-visible setup or validation messages

The app should not persist raw Slack file bytes or generated transcripts unless a future feature
explicitly adds a documented storage path.

## Stored Data

PostgreSQL stores application data needed for operation, including Slack installations, workspace and
channel settings, routing configuration, OAuth state and connections, workspace credentials,
Salesforce workflow settings, RSS feed state, and related JSON documents.

Slack OAuth installation records store Slack bot and user tokens in the `slack_installations` and
`slack_bots` tables, so operators must protect the PostgreSQL database, backups, exports, and logs
as sensitive systems. Workspace provider API keys and implemented Google/Salesforce OAuth token
flows use encrypted repository-backed stores. Static Slack, OAuth client, encryption, provider
fallback, and deployment secrets must be injected through the deployment platform or secret manager
rather than committed to the repository.

## Generated Media And Files

Media generation, speech generation, Salesforce PDF workflows, and SORACOM tools can produce files,
bytes, provider URIs, or long-running operation handoffs. The app may upload generated files back to
Slack or store generated media in configured object storage when a feature requires it.

Operators should review provider terms for generated output rights, safety policies, retention, and
logging before enabling those features.

## Operator Checklist

- Review the current terms and data settings for every enabled provider and external service.
- Configure workspace credentials and OAuth tokens through encrypted stores or secret managers.
- Keep `.env` files, Terraform state, database URLs, OAuth credentials, provider keys, and encryption
  keys out of commits, issues, logs, screenshots, and release archives.
- Confirm Slack app scopes and user scopes match the enabled features.
- Disable feature settings by default unless the workspace has approved the related data flow.
