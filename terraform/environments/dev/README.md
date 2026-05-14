# Dev Environment Terraform

This Terraform environment creates the Heroku dev app, Heroku Postgres, Heroku Redis/KVS, buildpack
configuration, non-secret app config vars, and optional dyno formation.

Secret values are intentionally not managed by Terraform. Set Slack, OAuth, encryption, Salesforce,
and external API secrets with `heroku config:set` or CI secret injection after applying
infrastructure.

## Prerequisites

- Terraform
- Heroku account access for the target app
- `HEROKU_API_KEY` exported in your shell, or an authenticated Heroku CLI/netrc session

Do not put Heroku API keys or application secrets in `.tfvars`.

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
