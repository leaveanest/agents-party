variable "project_id" {
  description = "Google Cloud project id."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run resources."
  type        = string
}

variable "service_name" {
  description = "Cloud Run service name."
  type        = string
}

variable "job_name" {
  description = "Cloud Run job name used for migrations."
  type        = string
}

variable "container_image" {
  description = "Container image used by the service and migration job."
  type        = string
}

variable "service_account_email" {
  description = "Runtime service account email used by Cloud Run."
  type        = string
}

variable "plain_env" {
  description = "Plaintext environment variables shared by the service and job."
  type        = map(string)
  default     = {}
}

variable "secret_env" {
  description = "Secret Manager backed environment variables shared by the service and job."
  type = map(object({
    secret_id = string
    version   = optional(string, "latest")
  }))
  default = {}
}

variable "container_port" {
  description = "Application container port."
  type        = number
  default     = 8000
}

variable "allow_unauthenticated" {
  description = "Whether the Cloud Run service should accept unauthenticated requests."
  type        = bool
  default     = true
}

variable "job_command" {
  description = "Command executed by the migration job."
  type        = list(string)
  default     = ["uv", "run", "alembic"]
}

variable "job_args" {
  description = "Arguments executed by the migration job."
  type        = list(string)
  default     = ["upgrade", "head"]
}
