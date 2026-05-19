# AWS Environment Terraform

This Terraform environment creates an AWS deployment target for Party on Slack in Tokyo
(`ap-northeast-1`):

- ECS Fargate services for `web` and `worker`
- ECS one-off task definitions for `migrate` and `seed`
- EventBridge Scheduler for the RSS feed batch processor
- One ALB target group for the web process
- RDS PostgreSQL 16
- ElastiCache Redis for BullMQ handoff
- S3 for S3-compatible object storage
- ECS task roles for least-privilege S3 access
- CloudWatch Logs groups

It is intentionally separate from `terraform/environments/dev`, which manages the Heroku app.

## Runtime Secrets

Do not store Slack, OAuth, encryption, or database connection strings in `.tfvars`. Put them in
Secrets Manager or SSM Parameter Store, then pass their ARNs through `runtime_secret_arns`.

At minimum, production-like tasks need:

- `DATABASE_URL`
- `LLM_API_KEY_ENCRYPTION_KEY`
- `SLACK_SIGNING_SECRET`
- `SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`
- `SLACK_STATE_SECRET`

The RDS instance uses AWS-managed master credentials. After creating the database, create the
`DATABASE_URL` secret out of band from the RDS endpoint and managed password.

## Object Storage

AWS uses a private S3 bucket and ECS task role permissions. The application receives:

- `OBJECT_STORAGE_BUCKET`
- `OBJECT_STORAGE_REGION`
- optional `OBJECT_STORAGE_PREFIX`

Static AWS access keys are not required on ECS. Heroku uses Bucketeer instead; the application can
read Bucketeer config vars as the same object storage settings.

## Network Shape

The default keeps Fargate tasks in public subnets with security groups allowing inbound traffic only
from the ALB. RDS and Redis stay in private subnets. This avoids a NAT Gateway in the default cost
baseline. If `assign_public_ip = false`, add NAT or VPC endpoints for ECR, CloudWatch Logs, Secrets
Manager, and any outbound provider APIs before applying.

## First Plan

```bash
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform validate
terraform plan -var-file=terraform.tfvars
```

Run database migrations as a one-off ECS task before scaling application services to new code that
requires schema changes. The `migrate_task_definition_arn` output identifies the task definition to
use with `aws ecs run-task`.

## RSS Feed Schedule

Set `enable_rss_feed_schedule = true` to run `node dist/rssFeedWorker.mjs` from EventBridge
Scheduler as an ECS Fargate one-off task. The default schedule is `rate(10 minutes)` to match the
minimum interval available in Heroku Scheduler.

The scheduled task uses the same runtime environment and secrets as the app tasks, writes logs to
`/ecs/<project>-<environment>/rss-feed`, and uses the maintenance task role without S3 object
storage permissions. Scheduler target delivery failures are sent to the SQS DLQ exposed by
`rss_feed_scheduler_dlq_arn`; monitor that queue before enabling the schedule in production. Keep
the schedule disabled until database migrations and Slack/provider secrets are in place.

## Cost Notes

The default shape is intended to approximate the current Heroku production resource tier while
keeping AWS costs explicit:

- Fargate web default: 2 vCPU / 16 GiB
- Fargate worker default: 1 vCPU / 2 GiB
- Scheduled RSS task default: 0.5 vCPU / 1 GiB per run
- RDS default: `db.r7g.large`, Single-AZ, gp3 512 GB
- Redis default: `cache.t4g.micro`
- SQS DLQ for Scheduler delivery failures: request-based, normally negligible
- S3: charged by storage, requests, and data transfer

Use Multi-AZ RDS, NAT Gateway, larger Redis nodes, or additional Fargate tasks only after deciding
that the added availability or throughput is worth the incremental cost.
