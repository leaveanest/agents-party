# SORACOM Integration

Agents party exposes SORACOM as read-only agent tools. Slack users do not run slash
commands and Slack routing does not select a SORACOM-specific specialist. The selected
model decides whether to call these tools during normal tool calling.

## Credential

Workspace admins configure a SORACOM AuthKey from Slack App Home:

- AuthKey ID is stored in `workspace_credentials.payload.auth_key_id`.
- AuthKey Secret is encrypted in `workspace_credentials.secret_encrypted`.
- Coverage is stored as `payload.coverage_type`, either `global` or `japan`.
- The credential row uses `provider_kind=soracom` and `credential_name=auth_key`.

Do not put token, AuthKey Secret, API key, or temporary SORACOM token values in payload,
logs, Slack messages, or Linear tickets.

## API Boundary

`src/integrations/soracom/` owns SORACOM HTTP access.

- Auth uses `POST /v1/auth` with `authKeyId` and `authKey`.
- Authenticated calls send `X-Soracom-API-Key` and `X-Soracom-Token`.
- Global coverage uses `https://g.api.soracom.io`.
- Japan coverage uses `https://api.soracom.io`.
- Rate limit headers are preserved as tool output metadata when available.

The implementation follows the SORACOM AuthKey and API Usage Guide:

- https://developers.soracom.io/en/docs/security/authkeys/
- https://developers.soracom.io/en/docs/tools/api-usage-guide/
- https://developers.soracom.io/en/docs/reference/endpoints

## Tools

MVP tools are read-only:

- `soracom_get_sim_status`
- `soracom_find_resources`
- `soracom_get_sim_status_history`
- `soracom_list_soracam_devices`
- `soracom_list_soracam_events`
- `soracom_get_soracam_export_usage`

These tools normalize SORACOM responses before returning JSON to the model. They should
return setup guidance when credentials are missing and structured failures for SORACOM
401, 403, 404, 429, and 5xx responses.

## Out Of Scope

- Slash commands
- Specialist runtime or keyword-triggered routing
- SIM activation, suspension, termination, session deletion, group/tag updates, SMS, or downlink
- SoraCam live image, stream, reboot, power state changes, or export execution
- Billing exports or other potentially heavy/background operations

## Validation

Run:

```bash
vp check
vp run typecheck
vp test
vp pack
```
