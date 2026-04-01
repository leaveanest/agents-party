output "instance_connection_name" {
  description = "Cloud SQL instance connection name."
  value       = google_sql_database_instance.this.connection_name
}

output "database_name" {
  description = "Application database name."
  value       = google_sql_database.app.name
}

output "iam_db_user_name" {
  description = "IAM database username derived from the runtime service account."
  value       = local.iam_db_user_name
}
