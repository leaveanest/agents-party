output "cloudflare_zone_id" {
  description = "Cloudflare zone ID managed by this Terraform environment."
  value       = var.cloudflare_zone_id
}

output "cloudflare_dns_record_ids" {
  description = "Cloudflare DNS record IDs keyed by dns_records map key."
  value       = { for key, record in cloudflare_dns_record.app : key => record.id }
}

output "cloudflare_dns_record_names" {
  description = "Fully-qualified DNS names managed by this Terraform environment."
  value       = { for key, record in cloudflare_dns_record.app : key => record.name }
}

output "cloudflare_ratelimit_ruleset_id" {
  description = "Cloudflare rate limit ruleset ID when rate limiting is enabled."
  value       = var.enable_ratelimit ? cloudflare_ruleset.app_ratelimit[0].id : null
}
