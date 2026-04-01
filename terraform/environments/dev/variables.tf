variable "project_id" {
  description = "Google Cloud project id."
  type        = string
}

variable "region" {
  description = "Primary deployment region."
  type        = string
  default     = "asia-northeast1"
}

variable "service_name" {
  description = "Cloud Run service name."
  type        = string
  default     = "agents-party"
}

variable "migration_job_name" {
  description = "Cloud Run migration job name."
  type        = string
  default     = "agents-party-migrate"
}

variable "runtime_service_account_id" {
  description = "Service account id used by Cloud Run."
  type        = string
  default     = "agents-party-runtime"
}

variable "container_image" {
  description = "Container image deployed to Cloud Run."
  type        = string
}

variable "cloud_sql_instance_name" {
  description = "Cloud SQL instance name."
  type        = string
  default     = "agents-party-db"
}

variable "cloud_sql_database_name" {
  description = "Application database name."
  type        = string
  default     = "agents_party"
}

variable "cloud_sql_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-custom-1-3840"
}

variable "default_timezone" {
  description = "Application default timezone."
  type        = string
  default     = "UTC"
}

variable "agent_selector_model" {
  description = "Default model for selector routing."
  type        = string
  default     = "google-gla:gemini-3-flash-preview"
}

variable "work_manager_model" {
  description = "Default model for work manager execution."
  type        = string
  default     = "google-gla:gemini-3-flash-preview"
}

variable "slack_bot_token_secret_id" {
  description = "Secret Manager secret id containing SLACK_BOT_TOKEN."
  type        = string
}

variable "slack_signing_secret_secret_id" {
  description = "Secret Manager secret id containing SLACK_SIGNING_SECRET."
  type        = string
}

variable "slack_app_token_secret_id" {
  description = "Optional Secret Manager secret id containing SLACK_APP_TOKEN."
  type        = string
  default     = null
  nullable    = true
}

variable "additional_plain_env" {
  description = "Additional plaintext environment variables for Cloud Run."
  type        = map(string)
  default     = {}
}

variable "additional_secret_env" {
  description = "Additional Secret Manager backed environment variables for Cloud Run."
  type = map(object({
    secret_id = string
    version   = optional(string, "latest")
  }))
  default = {}
}
