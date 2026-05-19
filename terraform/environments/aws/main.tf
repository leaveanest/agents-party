data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  name_prefix                        = "${var.project_name}-${var.environment}"
  bucket_name                        = coalesce(var.object_storage_bucket_name, "${local.name_prefix}-objects")
  object_storage_prefix              = var.object_storage_prefix == null ? null : trimprefix(trimsuffix(var.object_storage_prefix, "/"), "/")
  object_storage_object_resource_arn = local.object_storage_prefix == null || local.object_storage_prefix == "" ? "${aws_s3_bucket.objects.arn}/*" : "${aws_s3_bucket.objects.arn}/${local.object_storage_prefix}/*"
  object_storage_list_prefixes       = local.object_storage_prefix == null || local.object_storage_prefix == "" ? ["*"] : [local.object_storage_prefix, "${local.object_storage_prefix}/*"]
  rss_feed_schedule_arn              = "arn:${data.aws_partition.current.partition}:scheduler:${var.aws_region}:${data.aws_caller_identity.current.account_id}:schedule/default/${local.name_prefix}-rss-feed"
  common_tags = {
    Application = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
  base_environment = merge(
    {
      AGENT_MODEL               = var.agent_model
      APP_ENV                   = "production"
      APP_HOST                  = "0.0.0.0"
      APP_NAME                  = var.app_name
      AWS_REGION                = var.aws_region
      OBJECT_STORAGE_BUCKET     = aws_s3_bucket.objects.bucket
      OBJECT_STORAGE_REGION     = var.aws_region
      PORT                      = tostring(var.container_port)
      REDIS_URL                 = "redis://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
      SLACK_AGENT_QUEUE_ENABLED = "true"
    },
    var.object_storage_prefix == null ? {} : {
      OBJECT_STORAGE_PREFIX = var.object_storage_prefix
    },
    var.additional_environment,
  )
  container_secrets = [
    for name, value_from in var.runtime_secret_arns : {
      name      = name
      valueFrom = value_from
    }
  ]
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = local.name_prefix
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-igw"
  }
}

resource "aws_subnet" "public" {
  count = length(var.public_subnet_cidrs)

  availability_zone       = data.aws_availability_zones.available.names[count.index]
  cidr_block              = var.public_subnet_cidrs[count.index]
  map_public_ip_on_launch = true
  vpc_id                  = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-public-${count.index + 1}"
  }
}

resource "aws_subnet" "private" {
  count = length(var.private_subnet_cidrs)

  availability_zone = data.aws_availability_zones.available.names[count.index]
  cidr_block        = var.private_subnet_cidrs[count.index]
  vpc_id            = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-private-${count.index + 1}"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${local.name_prefix}-public"
  }
}

resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  route_table_id = aws_route_table.public.id
  subnet_id      = aws_subnet.public[count.index].id
}

resource "aws_security_group" "alb" {
  name        = "${local.name_prefix}-alb"
  description = "Allow public HTTP and HTTPS traffic to the application load balancer."
  vpc_id      = aws_vpc.main.id

  ingress {
    cidr_blocks = ["0.0.0.0/0"]
    from_port   = 80
    protocol    = "tcp"
    to_port     = 80
  }

  ingress {
    cidr_blocks = ["0.0.0.0/0"]
    from_port   = 443
    protocol    = "tcp"
    to_port     = 443
  }

  egress {
    cidr_blocks = ["0.0.0.0/0"]
    from_port   = 0
    protocol    = "-1"
    to_port     = 0
  }
}

resource "aws_security_group" "ecs" {
  name        = "${local.name_prefix}-ecs"
  description = "Allow ALB traffic to ECS tasks."
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
    to_port         = var.container_port
  }

  egress {
    cidr_blocks = ["0.0.0.0/0"]
    from_port   = 0
    protocol    = "-1"
    to_port     = 0
  }
}

resource "aws_security_group" "database" {
  name        = "${local.name_prefix}-database"
  description = "Allow PostgreSQL from ECS tasks."
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
    to_port         = 5432
  }
}

resource "aws_security_group" "redis" {
  name        = "${local.name_prefix}-redis"
  description = "Allow Redis from ECS tasks."
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
    to_port         = 6379
  }
}

resource "aws_lb" "app" {
  name               = "${local.name_prefix}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
}

resource "aws_lb_target_group" "web" {
  name        = "${local.name_prefix}-web"
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  health_check {
    matcher = "200"
    path    = "/healthz"
  }
}

resource "aws_lb_listener" "http_forward" {
  count = var.certificate_arn == null ? 1 : 0

  default_action {
    target_group_arn = aws_lb_target_group.web.arn
    type             = "forward"
  }

  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"
}

resource "aws_lb_listener" "http_redirect" {
  count = var.certificate_arn == null ? 0 : 1

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }

  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"
}

resource "aws_lb_listener" "https" {
  count = var.certificate_arn == null ? 0 : 1

  certificate_arn = var.certificate_arn

  default_action {
    target_group_arn = aws_lb_target_group.web.arn
    type             = "forward"
  }

  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "postgres" {
  allocated_storage           = var.database_allocated_storage
  backup_retention_period     = var.database_backup_retention_period
  db_name                     = var.database_name
  db_subnet_group_name        = aws_db_subnet_group.main.name
  deletion_protection         = true
  engine                      = "postgres"
  engine_version              = "16"
  final_snapshot_identifier   = "${local.name_prefix}-postgres-final"
  identifier                  = "${local.name_prefix}-postgres"
  instance_class              = var.database_instance_class
  manage_master_user_password = true
  multi_az                    = var.database_multi_az
  skip_final_snapshot         = false
  storage_encrypted           = true
  storage_type                = "gp3"
  username                    = var.database_username
  vpc_security_group_ids      = [aws_security_group.database.id]
}

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name_prefix}-redis"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_replication_group" "redis" {
  automatic_failover_enabled = false
  at_rest_encryption_enabled = true
  description                = "Redis queue for ${local.name_prefix}"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  num_cache_clusters         = 1
  port                       = 6379
  replication_group_id       = "${local.name_prefix}-redis"
  security_group_ids         = [aws_security_group.redis.id]
  subnet_group_name          = aws_elasticache_subnet_group.main.name
}

resource "aws_s3_bucket" "objects" {
  bucket = local.bucket_name
}

resource "aws_s3_bucket_public_access_block" "objects" {
  block_public_acls       = true
  block_public_policy     = true
  bucket                  = aws_s3_bucket.objects.id
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "objects" {
  bucket = aws_s3_bucket.objects.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "objects" {
  bucket = aws_s3_bucket.objects.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "objects" {
  count = var.object_storage_lifecycle_expiration_days == null ? 0 : 1

  bucket = aws_s3_bucket.objects.id

  rule {
    id     = "expire-object-storage-prefix"
    status = "Enabled"

    filter {
      prefix = var.object_storage_prefix == null ? "" : "${trimprefix(trimsuffix(var.object_storage_prefix, "/"), "/")}/"
    }

    expiration {
      days = var.object_storage_lifecycle_expiration_days
    }
  }
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${local.name_prefix}/web"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.name_prefix}/worker"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "rss_feed" {
  name              = "/ecs/${local.name_prefix}/rss-feed"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/ecs/${local.name_prefix}/migrate"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "seed" {
  name              = "/ecs/${local.name_prefix}/seed"
  retention_in_days = 30
}

data "aws_iam_policy_document" "ecs_tasks_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      identifiers = ["ecs-tasks.amazonaws.com"]
      type        = "Service"
    }
  }
}

data "aws_iam_policy_document" "scheduler_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    condition {
      test     = "StringEquals"
      values   = [data.aws_caller_identity.current.account_id]
      variable = "aws:SourceAccount"
    }

    condition {
      test     = "ArnLike"
      values   = [local.rss_feed_schedule_arn]
      variable = "aws:SourceArn"
    }

    principals {
      identifiers = ["scheduler.amazonaws.com"]
      type        = "Service"
    }
  }
}

resource "aws_iam_role" "task_execution" {
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  name               = "${local.name_prefix}-task-execution"
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
  role       = aws_iam_role.task_execution.name
}

data "aws_iam_policy_document" "task_execution_secrets" {
  count = length(var.runtime_secret_arns) == 0 ? 0 : 1

  statement {
    actions   = ["secretsmanager:GetSecretValue", "ssm:GetParameters", "ssm:GetParameter"]
    resources = values(var.runtime_secret_arns)
  }
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  count = length(var.runtime_secret_arns) == 0 ? 0 : 1

  name   = "${local.name_prefix}-task-execution-secrets"
  policy = data.aws_iam_policy_document.task_execution_secrets[0].json
  role   = aws_iam_role.task_execution.id
}

resource "aws_iam_role" "task" {
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  name               = "${local.name_prefix}-app-task"
}

resource "aws_iam_role" "maintenance_task" {
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  name               = "${local.name_prefix}-maintenance-task"
}

resource "aws_iam_role" "scheduler" {
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume_role.json
  name               = "${local.name_prefix}-scheduler"
}

resource "aws_sqs_queue" "rss_feed_scheduler_dlq" {
  message_retention_seconds = 1209600
  name                      = "${local.name_prefix}-rss-feed-scheduler-dlq"
  sqs_managed_sse_enabled   = true
}

data "aws_iam_policy_document" "object_storage" {
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.objects.arn]

    dynamic "condition" {
      for_each = local.object_storage_prefix == null || local.object_storage_prefix == "" ? [] : [1]

      content {
        test     = "StringLike"
        values   = local.object_storage_list_prefixes
        variable = "s3:prefix"
      }
    }
  }

  statement {
    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = [local.object_storage_object_resource_arn]
  }
}

resource "aws_iam_role_policy" "object_storage" {
  name   = "${local.name_prefix}-object-storage"
  policy = data.aws_iam_policy_document.object_storage.json
  role   = aws_iam_role.task.id
}

resource "aws_ecs_cluster" "main" {
  name = local.name_prefix
}

resource "aws_ecs_task_definition" "web" {
  container_definitions = jsonencode([
    {
      command     = ["node", "dist/main.mjs"]
      environment = [for name, value in local.base_environment : { name = name, value = value }]
      essential   = true
      image       = var.container_image
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.web.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "web"
        }
      }
      name = "web"
      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = var.container_port
          protocol      = "tcp"
        }
      ]
      secrets = local.container_secrets
    }
  ])
  cpu                      = var.web_cpu
  execution_role_arn       = aws_iam_role.task_execution.arn
  family                   = "${local.name_prefix}-web"
  memory                   = var.web_memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  task_role_arn            = aws_iam_role.task.arn
}

resource "aws_ecs_task_definition" "worker" {
  container_definitions = jsonencode([
    {
      command     = ["node", "dist/worker.mjs"]
      environment = [for name, value in local.base_environment : { name = name, value = value }]
      essential   = true
      image       = var.container_image
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.worker.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "worker"
        }
      }
      name    = "worker"
      secrets = local.container_secrets
    }
  ])
  cpu                      = var.worker_cpu
  execution_role_arn       = aws_iam_role.task_execution.arn
  family                   = "${local.name_prefix}-worker"
  memory                   = var.worker_memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  task_role_arn            = aws_iam_role.task.arn
}

resource "aws_ecs_task_definition" "rss_feed" {
  container_definitions = jsonencode([
    {
      command     = ["node", "dist/rssFeedWorker.mjs"]
      environment = [for name, value in local.base_environment : { name = name, value = value }]
      essential   = true
      image       = var.container_image
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.rss_feed.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "rss-feed"
        }
      }
      name    = "rss-feed"
      secrets = local.container_secrets
    }
  ])
  cpu                      = var.rss_feed_task_cpu
  execution_role_arn       = aws_iam_role.task_execution.arn
  family                   = "${local.name_prefix}-rss-feed"
  memory                   = var.rss_feed_task_memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  task_role_arn            = aws_iam_role.maintenance_task.arn
}

resource "aws_ecs_task_definition" "migrate" {
  container_definitions = jsonencode([
    {
      command     = ["node", "dist/infrastructure/postgres/runMigrations.mjs"]
      environment = [for name, value in local.base_environment : { name = name, value = value }]
      essential   = true
      image       = var.container_image
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.migrate.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "migrate"
        }
      }
      name    = "migrate"
      secrets = local.container_secrets
    }
  ])
  cpu                      = 512
  execution_role_arn       = aws_iam_role.task_execution.arn
  family                   = "${local.name_prefix}-migrate"
  memory                   = 1024
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  task_role_arn            = aws_iam_role.maintenance_task.arn
}

resource "aws_ecs_task_definition" "seed" {
  container_definitions = jsonencode([
    {
      command     = ["node", "dist/infrastructure/postgres/seedBootstrap.mjs"]
      environment = [for name, value in local.base_environment : { name = name, value = value }]
      essential   = true
      image       = var.container_image
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.seed.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "seed"
        }
      }
      name    = "seed"
      secrets = local.container_secrets
    }
  ])
  cpu                      = 512
  execution_role_arn       = aws_iam_role.task_execution.arn
  family                   = "${local.name_prefix}-seed"
  memory                   = 1024
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  task_role_arn            = aws_iam_role.maintenance_task.arn
}

data "aws_iam_policy_document" "scheduler_rss_feed" {
  statement {
    actions   = ["ecs:RunTask"]
    resources = [aws_ecs_task_definition.rss_feed.arn]
  }

  statement {
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.maintenance_task.arn,
      aws_iam_role.task_execution.arn,
    ]

    condition {
      test     = "StringEquals"
      values   = ["ecs-tasks.amazonaws.com"]
      variable = "iam:PassedToService"
    }
  }

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.rss_feed_scheduler_dlq.arn]
  }
}

resource "aws_iam_role_policy" "scheduler_rss_feed" {
  name   = "${local.name_prefix}-scheduler-rss-feed"
  policy = data.aws_iam_policy_document.scheduler_rss_feed.json
  role   = aws_iam_role.scheduler.id
}

resource "aws_scheduler_schedule" "rss_feed" {
  count = var.enable_rss_feed_schedule ? 1 : 0

  description         = "Run RSS feed batch processing for ${local.name_prefix}."
  name                = "${local.name_prefix}-rss-feed"
  schedule_expression = var.rss_feed_schedule_expression
  state               = "ENABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_ecs_cluster.main.arn
    role_arn = aws_iam_role.scheduler.arn

    dead_letter_config {
      arn = aws_sqs_queue.rss_feed_scheduler_dlq.arn
    }

    ecs_parameters {
      launch_type         = "FARGATE"
      task_count          = 1
      task_definition_arn = aws_ecs_task_definition.rss_feed.arn

      network_configuration {
        assign_public_ip = var.assign_public_ip
        security_groups  = [aws_security_group.ecs.id]
        subnets          = aws_subnet.public[*].id
      }
    }

    retry_policy {
      maximum_event_age_in_seconds = 3600
      maximum_retry_attempts       = 1
    }
  }
}

resource "aws_ecs_service" "web" {
  cluster         = aws_ecs_cluster.main.id
  desired_count   = var.web_desired_count
  launch_type     = "FARGATE"
  name            = "web"
  task_definition = aws_ecs_task_definition.web.arn
  depends_on      = [aws_lb_listener.http_forward, aws_lb_listener.https]

  load_balancer {
    container_name   = "web"
    container_port   = var.container_port
    target_group_arn = aws_lb_target_group.web.arn
  }

  network_configuration {
    assign_public_ip = var.assign_public_ip
    security_groups  = [aws_security_group.ecs.id]
    subnets          = aws_subnet.public[*].id
  }
}

resource "aws_ecs_service" "worker" {
  cluster         = aws_ecs_cluster.main.id
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"
  name            = "worker"
  task_definition = aws_ecs_task_definition.worker.arn

  network_configuration {
    assign_public_ip = var.assign_public_ip
    security_groups  = [aws_security_group.ecs.id]
    subnets          = aws_subnet.public[*].id
  }
}
