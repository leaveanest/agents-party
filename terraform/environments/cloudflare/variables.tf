variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for the public domain. Use an existing zone; this environment does not create zones."
  type        = string
}

variable "zone_name" {
  description = "Apex zone name, such as example.com. Used to normalize relative DNS record names."
  type        = string

  validation {
    condition     = length(trimspace(var.zone_name)) > 0 && !startswith(var.zone_name, ".") && !endswith(var.zone_name, ".")
    error_message = "zone_name must be a non-empty apex domain without a leading or trailing dot."
  }
}

variable "dns_records" {
  description = "DNS records managed by Terraform for the app. Names may be fully-qualified, @, or relative to zone_name."
  type = map(object({
    name    = string
    type    = string
    content = string
    proxied = optional(bool, true)
    ttl     = optional(number, 1)
    comment = optional(string)
  }))
  default = {}

  validation {
    condition = alltrue([
      for record in values(var.dns_records) :
      contains(["A", "AAAA", "CNAME"], upper(record.type))
    ])
    error_message = "dns_records currently supports A, AAAA, and CNAME records."
  }

  validation {
    condition = alltrue([
      for record in values(var.dns_records) :
      record.ttl == null || record.ttl == 1 || (record.ttl >= 60 && record.ttl <= 86400)
    ])
    error_message = "dns_records ttl must be 1 for automatic TTL, or between 60 and 86400 seconds."
  }
}

variable "ssl_mode" {
  description = "Cloudflare SSL mode for proxied records. Use strict when the origin has a valid public or Cloudflare Origin CA certificate."
  type        = string
  default     = "strict"

  validation {
    condition     = contains(["off", "flexible", "full", "strict"], var.ssl_mode)
    error_message = "ssl_mode must be one of off, flexible, full, or strict."
  }
}

variable "min_tls_version" {
  description = "Minimum TLS version served by Cloudflare at the edge."
  type        = string
  default     = "1.2"

  validation {
    condition     = contains(["1.0", "1.1", "1.2", "1.3"], var.min_tls_version)
    error_message = "min_tls_version must be one of 1.0, 1.1, 1.2, or 1.3."
  }
}

variable "enable_always_use_https" {
  description = "Whether Cloudflare redirects HTTP requests to HTTPS."
  type        = bool
  default     = true
}

variable "enable_tls_1_3" {
  description = "Whether TLS 1.3 is enabled at the Cloudflare edge."
  type        = bool
  default     = true
}

variable "enable_http3" {
  description = "Whether HTTP/3 is enabled at the Cloudflare edge."
  type        = bool
  default     = true
}

variable "enable_ratelimit" {
  description = "Whether to create a zone-level rate limit ruleset for public app endpoints."
  type        = bool
  default     = false
}

variable "ratelimit_expression" {
  description = "Optional Cloudflare rules language expression for rate-limited requests. Leave null to derive one from ratelimit_paths."
  type        = string
  default     = null
}

variable "ratelimit_paths" {
  description = "App route paths covered by the default rate limit expression. Keep this aligned with any customized Slack and OAuth route environment variables."
  type        = list(string)
  default = [
    "/slack/events",
    "/slack/install",
    "/slack/oauth_redirect",
    "/oauth/google/start",
    "/oauth/google/callback",
    "/oauth/salesforce/start",
    "/oauth/salesforce/callback",
    "/oauth/salesforce/disconnect",
  ]

  validation {
    condition = alltrue([
      for path in var.ratelimit_paths : startswith(path, "/") && length(trimspace(path)) > 1
    ])
    error_message = "ratelimit_paths entries must be absolute app paths such as /slack/events."
  }
}

variable "ratelimit_period_seconds" {
  description = "Rate limit counting period in seconds."
  type        = number
  default     = 60
}

variable "ratelimit_requests_per_period" {
  description = "Maximum requests per IP and Cloudflare colo during ratelimit_period_seconds."
  type        = number
  default     = 120
}

variable "ratelimit_mitigation_timeout_seconds" {
  description = "Seconds to block a client after it exceeds the rate limit."
  type        = number
  default     = 60
}
