# Cloudflare Environment Terraform

This Terraform environment manages the Cloudflare edge configuration for Party on Slack:

- DNS records for the public app hostname
- Cloudflare proxy enablement per record
- Zone HTTPS settings: SSL mode, Always Use HTTPS, minimum TLS version, TLS 1.3, and HTTP/3
- Optional zone-level rate limiting for Slack and OAuth ingress paths

It does not deploy the TypeScript app to Cloudflare Workers or Pages. The app remains hosted on an
origin such as Heroku or AWS ECS, and Cloudflare sits in front of that origin for DNS, TLS, proxying,
and edge controls.

## Prerequisites

- Terraform
- Existing Cloudflare zone
- API token exported as `CLOUDFLARE_API_TOKEN`

Use a scoped Cloudflare API token. Typical permissions for the default configuration are:

- `Zone Settings:Edit`
- `DNS:Edit`
- `Zone WAF:Edit` only when `enable_ratelimit = true`

Do not put Cloudflare API tokens in `.tfvars`.

## First Plan

```bash
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform validate
terraform plan -var-file=terraform.tfvars
```

For a Heroku origin, set `dns_records[*].content` to the Heroku app hostname, for example
`agents-party-dev.herokuapp.com`. For AWS, set it to the ALB DNS name or another stable origin
hostname. Do not include `https://` or a path.

## TLS Mode

The default `ssl_mode = "strict"` requires the origin to present a valid certificate for the public
hostname. If the origin is not ready for strict validation yet, use `ssl_mode = "full"` temporarily
and move back to `strict` after installing a valid public or Cloudflare Origin CA certificate at the
origin.

Cloudflare zone settings are mutable settings rather than deletable objects. The provider may warn
that `cloudflare_zone_setting` resources cannot be destroyed from Terraform; removing a setting
resource from this environment does not automatically reset the setting in Cloudflare.

## Rate Limiting

Set `enable_ratelimit = true` to create one zone-level `http_ratelimit` ruleset covering
`ratelimit_paths`. The default list matches the app's default Slack and OAuth route settings:

- `/slack/events`
- `/slack/install`
- `/slack/oauth_redirect`
- `/oauth/google/start`
- `/oauth/google/callback`
- `/oauth/salesforce/start`
- `/oauth/salesforce/callback`
- `/oauth/salesforce/disconnect`

Tune `ratelimit_requests_per_period` conservatively. Slack retries and outage recovery can create
short bursts, so validate the configured threshold against real traffic before enabling it in
production.

If an environment customizes app route environment variables such as `SLACK_EVENTS_PATH`,
`SLACK_INSTALL_PATH`, `SLACK_OAUTH_REDIRECT_PATH`, `GOOGLE_OAUTH_*_PATH`, or
`SALESFORCE_OAUTH_*_PATH`, update `ratelimit_paths` in the same environment. For fully custom
Cloudflare rules language, set `ratelimit_expression` directly.

Cloudflare allows only one zone entrypoint ruleset per phase. If this zone already has a
Terraform-managed `http_ratelimit` ruleset, merge this rule into that ruleset instead of applying a
second resource.

## Existing DNS Records

If the target DNS record already exists in Cloudflare, import it before applying:

```bash
terraform import 'cloudflare_dns_record.app["app"]' '<zone_id>/<record_id>'
```

Use Cloudflare's dashboard or `cf-terraforming` to find existing record IDs.
