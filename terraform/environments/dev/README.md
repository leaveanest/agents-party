# Dev Environment Terraform

This Terraform environment creates the Heroku dev app, Heroku Postgres, Heroku Redis/KVS,
optional Bucketeer object storage, buildpack configuration, non-secret app config vars, and
optional dyno formation.

Secret values are intentionally not managed by Terraform. Set Slack, OAuth, encryption, Salesforce,
and external API secrets with `heroku config:set` or CI secret injection after applying
infrastructure.

## Prerequisites

- Terraform
- Heroku account access for the target app
- `HEROKU_API_KEY` exported in your shell, or an authenticated Heroku CLI/netrc session

Do not put Heroku API keys or application secrets in `.tfvars`.

## Object Storage

Set `enable_bucketeer = true` to provision Bucketeer as the standard Heroku S3-compatible
object storage add-on. Bucketeer injects `BUCKETEER_BUCKET_NAME`, `BUCKETEER_AWS_REGION`,
`BUCKETEER_AWS_ACCESS_KEY_ID`, and `BUCKETEER_AWS_SECRET_ACCESS_KEY` into the app config.
The application reads those values as object storage defaults, so Terraform does not copy the
secret values into managed app config.

`versions.tf` keeps `set_addon_config_vars_in_state = false`; do not change that unless the team
accepts storing add-on credentials in Terraform state.

## First Apply

```bash
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

After the first apply, set required runtime secrets outside Terraform:

```bash
heroku config:set \
  SLACK_SIGNING_SECRET=... \
  SLACK_CLIENT_ID=... \
  SLACK_CLIENT_SECRET=... \
  SLACK_STATE_SECRET=... \
  LLM_API_KEY_ENCRYPTION_KEY=... \
  -a agents-party-dev
```

Deploy the application from Git so Heroku creates the `web` and `worker` process types from the
root `Procfile`:

```bash
heroku git:remote -a agents-party-dev
git push heroku main
```

## Managing Dynos

Leave `manage_web_formation`, `manage_worker_formation`, and `slack_agent_queue_enabled` disabled
for the first apply. After the first Heroku release has created the process types, enable them in
`terraform.tfvars` if Terraform should manage dyno quantity and queue mode:

```hcl
manage_web_formation      = true
manage_worker_formation   = true
slack_agent_queue_enabled = true
```

Then re-run:

```bash
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```
