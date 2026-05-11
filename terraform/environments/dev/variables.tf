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
  ]
}

variable "heroku_postgres_plan" {
  description = "Heroku Postgres add-on plan."
  type        = string
  default     = "heroku-postgresql:essential-0"
}

variable "heroku_inference_plan" {
  description = "Heroku Managed Inference and Agents add-on plan."
  type        = string
  default     = "heroku-inference:standard"
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
