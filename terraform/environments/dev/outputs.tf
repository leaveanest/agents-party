output "heroku_app_name" {
  description = "Heroku app name."
  value       = heroku_app.app.name
}

output "heroku_app_url" {
  description = "Heroku app URL."
  value       = heroku_app.app.web_url
}

output "heroku_postgres_addon_name" {
  description = "Heroku Postgres add-on name."
  value       = heroku_addon.postgres.name
}

output "heroku_inference_addon_name" {
  description = "Heroku Managed Inference and Agents add-on name."
  value       = heroku_addon.inference.name
}

output "heroku_redis_addon_name" {
  description = "Heroku Key-Value Store/Redis add-on name."
  value       = heroku_addon.redis.name
}
