variable "aws_region" {
  description = "AWS region for the Party on Slack environment."
  type        = string
  default     = "ap-northeast-1"
}

variable "project_name" {
  description = "Project name used for AWS resource names."
  type        = string
  default     = "agents-party"
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "prod"
}

variable "container_image" {
  description = "Container image URI for the TypeScript application."
  type        = string
}

variable "agent_model" {
  description = "Default model for TypeScript agent routing and specialist execution."
  type        = string
  default     = "google:gemini-2.5-flash"
}

variable "app_name" {
  description = "Display name for the application runtime."
  type        = string
  default     = "Agents party"
}

variable "container_port" {
  description = "Port exposed by the application container."
  type        = number
  default     = 8080
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets."
  type        = list(string)
  default     = ["10.42.0.0/24", "10.42.1.0/24"]
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for private data subnets."
  type        = list(string)
  default     = ["10.42.10.0/24", "10.42.11.0/24"]
}

variable "assign_public_ip" {
  description = "Whether Fargate tasks receive public IP addresses. Disable only after adding NAT or VPC endpoints for image pulls and logs."
  type        = bool
  default     = true
}

variable "allow_plain_http" {
  description = "Explicitly allow a public HTTP listener without ACM TLS. Keep false for production-like deployments."
  type        = bool
  default     = false
}

variable "certificate_arn" {
  description = "ACM certificate ARN for the public ALB HTTPS listener. Required unless allow_plain_http is explicitly true."
  type        = string
  default     = null
}

variable "web_desired_count" {
  description = "Desired number of web tasks."
  type        = number
  default     = 1
}

variable "worker_desired_count" {
  description = "Desired number of worker tasks."
  type        = number
  default     = 1
}

variable "web_cpu" {
  description = "Fargate CPU units for the web task."
  type        = number
  default     = 256
}

variable "web_memory" {
  description = "Fargate memory in MiB for the web task."
  type        = number
  default     = 512
}

variable "worker_cpu" {
  description = "Fargate CPU units for the worker task."
  type        = number
  default     = 256
}

variable "worker_memory" {
  description = "Fargate memory in MiB for the worker task."
  type        = number
  default     = 512
}

variable "enable_rss_feed_schedule" {
  description = "Whether to run the RSS feed batch processor on an EventBridge Scheduler schedule."
  type        = bool
  default     = false
}

variable "rss_feed_schedule_expression" {
  description = "EventBridge Scheduler expression for the RSS feed batch processor."
  type        = string
  default     = "rate(10 minutes)"
}

variable "rss_feed_task_cpu" {
  description = "Fargate CPU units for scheduled RSS feed batch tasks."
  type        = number
  default     = 512
}

variable "rss_feed_task_memory" {
  description = "Fargate memory in MiB for scheduled RSS feed batch tasks."
  type        = number
  default     = 1024
}

variable "runtime_secret_arns" {
  description = "Map of ECS environment variable names to Secrets Manager or SSM Parameter ARNs. Include DATABASE_URL and Slack/OAuth/encryption secrets here."
  type        = map(string)
  default     = {}
}

variable "additional_environment" {
  description = "Additional non-secret ECS environment variables."
  type        = map(string)
  default     = {}
}

variable "database_name" {
  description = "Initial PostgreSQL database name."
  type        = string
  default     = "agents_party"
}

variable "database_username" {
  description = "RDS master username."
  type        = string
  default     = "agents_party"
}

variable "database_instance_class" {
  description = "RDS PostgreSQL instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "database_allocated_storage" {
  description = "RDS PostgreSQL allocated storage in GB."
  type        = number
  default     = 20
}

variable "database_multi_az" {
  description = "Whether to enable RDS Multi-AZ."
  type        = bool
  default     = false
}

variable "database_backup_retention_period" {
  description = "RDS backup retention period in days."
  type        = number
  default     = 7
}

variable "redis_node_type" {
  description = "ElastiCache Redis node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "object_storage_bucket_name" {
  description = "Optional globally unique S3 bucket name. Leave null to derive one from project and environment."
  type        = string
  default     = null
}

variable "object_storage_prefix" {
  description = "Optional key prefix for object storage objects."
  type        = string
  default     = null
}

variable "object_storage_lifecycle_expiration_days" {
  description = "Optional lifecycle expiration in days for objects under the configured prefix."
  type        = number
  default     = null
}
