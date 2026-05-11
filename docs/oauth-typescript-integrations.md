# TypeScript OAuth Integrations

The TypeScript runtime owns the Google and Salesforce OAuth HTTP routes:

- `GET /oauth/google/start`
- `GET /oauth/google/callback`
- `GET /oauth/salesforce/start`
- `GET /oauth/salesforce/callback`
- `POST /oauth/salesforce/disconnect`

The implementation lives under `src/integrations/oauth/` and uses the existing PostgreSQL JSON document repositories for state and connection persistence. The runtime does not depend on removed Python OAuth routers, services, signers, or gateways.

## Compatibility

Context tokens, OAuth state tokens, stored access tokens, stored refresh tokens, Salesforce PKCE verifiers, and encrypted Salesforce client secrets use Fernet-compatible encryption in TypeScript.

- Context keys are derived as `base64url(sha256(secret))`, matching the pre-cutover context signers.
- Token encryption keys are read directly from `GOOGLE_TOKEN_ENCRYPTION_KEY` and `SALESFORCE_TOKEN_ENCRYPTION_KEY`, matching the existing Fernet key format.
- JSON payloads are stable-key serialized before context encryption so pre-cutover context tokens can be read during cutover.

## Configuration

Google OAuth is enabled only when all of these are present:

- `DATABASE_URL`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_BASE_URL`
- `GOOGLE_OAUTH_CONTEXT_SIGNING_SECRET`
- `GOOGLE_TOKEN_ENCRYPTION_KEY`

Salesforce OAuth is enabled only when all of these are present:

- `DATABASE_URL`
- `SALESFORCE_OAUTH_REDIRECT_BASE_URL`
- `SALESFORCE_OAUTH_CONTEXT_SIGNING_SECRET`
- `SALESFORCE_TOKEN_ENCRYPTION_KEY`

Salesforce workspace OAuth client configuration remains repository-backed in PostgreSQL.

Salesforce OAuth supports Authorization Code Flow with PKCE, encrypted access and refresh tokens,
refresh-token grant renewal, and revoke-backed disconnect. Refresh failures caused by revoked or
invalid refresh tokens mark the local connection `expired` so Salesforce-dependent features can
ask the Slack user to reconnect.
