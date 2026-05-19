output "alb_dns_name" {
  description = "Application Load Balancer DNS name."
  value       = aws_lb.app.dns_name
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.main.name
}

output "object_storage_bucket" {
  description = "S3 bucket used for S3-compatible object storage."
  value       = aws_s3_bucket.objects.bucket
}

output "migrate_task_definition_arn" {
  description = "One-off ECS task definition ARN for PostgreSQL migrations."
  value       = aws_ecs_task_definition.migrate.arn
}

output "seed_task_definition_arn" {
  description = "One-off ECS task definition ARN for bootstrap seed jobs."
  value       = aws_ecs_task_definition.seed.arn
}

output "postgres_endpoint" {
  description = "RDS PostgreSQL endpoint."
  value       = aws_db_instance.postgres.endpoint
}

output "redis_endpoint" {
  description = "ElastiCache Redis primary endpoint."
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "task_role_arn" {
  description = "ECS task role with S3 object storage permissions."
  value       = aws_iam_role.task.arn
}
