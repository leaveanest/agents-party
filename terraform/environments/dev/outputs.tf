output "cloud_run_service_url" {
  description = "Public Cloud Run service URL."
  value       = module.cloud_run_service.service_url
}

output "migration_job_name" {
  description = "Cloud Run job name used for Alembic migrations."
  value       = module.cloud_run_service.migration_job_name
}

output "cloud_sql_instance_connection_name" {
  description = "Cloud SQL instance connection name."
  value       = module.cloud_sql.instance_connection_name
}
