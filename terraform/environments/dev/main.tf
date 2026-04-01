locals {
  required_services = toset([
    "cloudresourcemanager.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
  ])

  plain_env = merge(
    {
      AGENT_SELECTOR_MODEL               = var.agent_selector_model
      APP_ENV                            = "cloudrun"
      CLOUD_SQL_DATABASE                 = module.cloud_sql.database_name
      CLOUD_SQL_IAM_DB_USER              = module.cloud_sql.iam_db_user_name
      CLOUD_SQL_INSTANCE_CONNECTION_NAME = module.cloud_sql.instance_connection_name
      CLOUD_SQL_IP_TYPE                  = "PUBLIC"
      DEFAULT_TIMEZONE                   = var.default_timezone
      WORK_MANAGER_MODEL                 = var.work_manager_model
    },
    var.additional_plain_env,
  )

  base_secret_env = {
    SLACK_BOT_TOKEN = {
      secret_id = var.slack_bot_token_secret_id
    }
    SLACK_SIGNING_SECRET = {
      secret_id = var.slack_signing_secret_secret_id
    }
  }

  optional_secret_env = var.slack_app_token_secret_id == null ? {} : {
    SLACK_APP_TOKEN = {
      secret_id = var.slack_app_token_secret_id
    }
  }

  secret_env = merge(local.base_secret_env, local.optional_secret_env, var.additional_secret_env)
}

resource "google_project_service" "required" {
  for_each           = local.required_services
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = var.runtime_service_account_id
  display_name = "agents-party Cloud Run runtime"
}

resource "google_project_iam_member" "runtime_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "runtime_secret_accessor" {
  count   = length(local.secret_env) > 0 ? 1 : 0
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

module "cloud_sql" {
  source = "../../modules/cloud_sql"

  project_id                = var.project_id
  region                    = var.region
  instance_name             = var.cloud_sql_instance_name
  database_name             = var.cloud_sql_database_name
  tier                      = var.cloud_sql_tier
  iam_service_account_email = google_service_account.runtime.email

  depends_on = [google_project_service.required]
}

module "cloud_run_service" {
  source = "../../modules/cloud_run_service"

  project_id            = var.project_id
  region                = var.region
  service_name          = var.service_name
  job_name              = var.migration_job_name
  container_image       = var.container_image
  service_account_email = google_service_account.runtime.email
  plain_env             = local.plain_env
  secret_env            = local.secret_env

  depends_on = [
    google_project_service.required,
    google_project_iam_member.runtime_cloudsql_client,
    google_project_iam_member.runtime_secret_accessor,
    module.cloud_sql,
  ]
}
