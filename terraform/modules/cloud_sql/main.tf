locals {
  iam_db_user_name = trimsuffix(var.iam_service_account_email, ".gserviceaccount.com")
}

resource "google_sql_database_instance" "this" {
  project             = var.project_id
  name                = var.instance_name
  region              = var.region
  database_version    = var.database_version
  deletion_protection = var.deletion_protection

  settings {
    tier = var.tier

    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
  }
}

resource "google_sql_database" "app" {
  project  = var.project_id
  name     = var.database_name
  instance = google_sql_database_instance.this.name
}

resource "google_sql_user" "runtime" {
  project  = var.project_id
  instance = google_sql_database_instance.this.name
  name     = local.iam_db_user_name
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}
