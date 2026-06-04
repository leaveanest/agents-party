locals {
  normalized_zone_name = trimsuffix(lower(trimspace(var.zone_name)), ".")

  dns_records = {
    for key, record in var.dns_records : key => {
      name = (
        trimspace(record.name) == "@"
        ? local.normalized_zone_name
        : endswith(lower(trimspace(record.name)), ".${local.normalized_zone_name}")
        ? trimsuffix(lower(trimspace(record.name)), ".")
        : "${lower(trimspace(record.name))}.${local.normalized_zone_name}"
      )
      type    = upper(record.type)
      content = trimspace(record.content)
      proxied = record.proxied
      ttl     = record.ttl
      comment = record.comment
    }
  }

  zone_settings = {
    ssl              = var.ssl_mode
    always_use_https = var.enable_always_use_https ? "on" : "off"
    min_tls_version  = var.min_tls_version
    tls_1_3          = var.enable_tls_1_3 ? "on" : "off"
    http3            = var.enable_http3 ? "on" : "off"
  }

  ratelimit_expression = (
    var.ratelimit_expression != null && trimspace(var.ratelimit_expression) != ""
    ? var.ratelimit_expression
    : "(http.request.uri.path in {${join(" ", [for path in var.ratelimit_paths : jsonencode(path)])}})"
  )
}

resource "cloudflare_dns_record" "app" {
  for_each = local.dns_records

  zone_id = var.cloudflare_zone_id
  name    = each.value.name
  type    = each.value.type
  content = each.value.content
  proxied = each.value.proxied
  ttl     = each.value.ttl
  comment = coalesce(each.value.comment, "Managed by Terraform for agents-party.")
}

resource "cloudflare_zone_setting" "app" {
  for_each = local.zone_settings

  zone_id    = var.cloudflare_zone_id
  setting_id = each.key
  value      = each.value
}

resource "cloudflare_ruleset" "app_ratelimit" {
  count = var.enable_ratelimit ? 1 : 0

  zone_id     = var.cloudflare_zone_id
  name        = "agents-party public endpoint rate limits"
  description = "Rate limits Slack and OAuth ingress paths for agents-party."
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [{
    ref         = "agents_party_public_endpoint_ip_limit"
    description = "Limit repeated requests to Slack and OAuth endpoints by IP."
    expression  = local.ratelimit_expression
    action      = "block"

    ratelimit = {
      characteristics     = ["cf.colo.id", "ip.src"]
      period              = var.ratelimit_period_seconds
      requests_per_period = var.ratelimit_requests_per_period
      mitigation_timeout  = var.ratelimit_mitigation_timeout_seconds
    }
  }]
}
