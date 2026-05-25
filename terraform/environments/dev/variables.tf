variable "heroku_app_name" {
  description = "Globally unique Heroku app name."
  type        = string
}

variable "heroku_region" {
  description = "Heroku region for the app and add-ons."
  type        = string
  default     = "us"
}

variable "heroku_stack" {
  description = "Heroku stack used by the app."
  type        = string
  default     = "heroku-24"
}

variable "heroku_buildpacks" {
  description = "Classic buildpacks used by the Heroku app."
  type        = list(string)
  default = [
    "heroku/nodejs",
    "heroku-community/cli",
  ]
}

variable "heroku_postgres_plan" {
  description = "Heroku Postgres add-on plan."
  type        = string
  default     = "heroku-postgresql:essential-0"
}

variable "heroku_redis_plan" {
  description = "Heroku Key-Value Store/Redis plan for Slack agent job queues."
  type        = string
  default     = "heroku-redis:mini"
}

variable "enable_bucketeer" {
  description = "Whether to provision Bucketeer for S3-compatible object storage."
  type        = bool
  default     = false
}

variable "bucketeer_plan" {
  description = "Bucketeer add-on plan for S3-compatible object storage."
  type        = string
  default     = "bucketeer:micro"
}

variable "object_storage_prefix" {
  description = "Optional key prefix for object storage objects, such as dev or prod."
  type        = string
  default     = null
}

variable "enable_scheduler" {
  description = "Whether to provision the Heroku Scheduler add-on. Individual scheduler jobs are configured in Heroku Scheduler after provisioning."
  type        = bool
  default     = false
}

variable "scheduler_plan" {
  description = "Heroku Scheduler add-on plan."
  type        = string
  default     = "scheduler:standard"
}

variable "rss_feed_scheduler_command" {
  description = "Command to register in Heroku Scheduler for RSS feed batch processing."
  type        = string
  default     = "node dist/rssFeedWorker.mjs"
}

variable "manage_web_formation" {
  description = "Whether Terraform manages the web dyno formation. The app must already have a release with a web process."
  type        = bool
  default     = false
}

variable "web_dyno_quantity" {
  description = "Number of web dynos to run when web formation management is enabled."
  type        = number
  default     = 1
}

variable "web_dyno_size" {
  description = "Dyno size for the web process when web formation management is enabled."
  type        = string
  default     = "basic"
}

variable "manage_worker_formation" {
  description = "Whether Terraform manages the worker dyno formation. The app must already have a release with a worker process."
  type        = bool
  default     = false
}

variable "slack_agent_queue_enabled" {
  description = "Whether the web process should enqueue Slack AI chat work to Redis instead of running it in-process."
  type        = bool
  default     = false
}

variable "worker_dyno_quantity" {
  description = "Number of worker dynos to run when worker formation management is enabled."
  type        = number
  default     = 1
}

variable "worker_dyno_size" {
  description = "Dyno size for the worker process when worker formation management is enabled."
  type        = string
  default     = "basic"
}

variable "agent_model" {
  description = "Default model for TypeScript agent routing and specialist execution."
  type        = string
  default     = "google:gemini-2.5-flash"
}

variable "additional_config_vars" {
  description = "Additional non-secret Heroku config vars managed by Terraform."
  type        = map(string)
  default     = {}
}
