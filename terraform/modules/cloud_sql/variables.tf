variable "project_id" {
  description = "Google Cloud project id."
  type        = string
}

variable "region" {
  description = "Region for the Cloud SQL instance."
  type        = string
}

variable "instance_name" {
  description = "Cloud SQL instance name."
  type        = string
}

variable "database_name" {
  description = "Application database created inside the Cloud SQL instance."
  type        = string
}

variable "iam_service_account_email" {
  description = "Runtime service account email granted IAM database login."
  type        = string
}

variable "database_version" {
  description = "Cloud SQL PostgreSQL engine version."
  type        = string
  default     = "POSTGRES_16"
}

variable "tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-custom-1-3840"
}

variable "deletion_protection" {
  description = "Whether to protect the Cloud SQL instance from deletion."
  type        = bool
  default     = false
}
