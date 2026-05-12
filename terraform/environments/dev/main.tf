locals {
  app_config_vars = merge(
    {
      AGENT_MODEL = var.agent_model
      APP_ENV     = "heroku"
    },
    var.additional_config_vars,
  )
}

resource "heroku_app" "app" {
  name       = var.heroku_app_name
  region     = var.heroku_region
  stack      = var.heroku_stack
  buildpacks = var.heroku_buildpacks

  config_vars = local.app_config_vars
}

resource "heroku_addon" "postgres" {
  app_id = heroku_app.app.id
  plan   = var.heroku_postgres_plan
}

resource "heroku_addon" "inference" {
  app_id = heroku_app.app.id
  plan   = var.heroku_inference_plan
}

resource "heroku_addon" "redis" {
  app_id = heroku_app.app.id
  plan   = var.heroku_redis_plan
}

resource "heroku_formation" "web" {
  count = var.manage_web_formation ? 1 : 0

  app_id   = heroku_app.app.id
  type     = "web"
  quantity = var.web_dyno_quantity
  size     = var.web_dyno_size
}

resource "heroku_formation" "worker" {
  count = var.manage_worker_formation ? 1 : 0

  app_id   = heroku_app.app.id
  type     = "worker"
  quantity = var.worker_dyno_quantity
  size     = var.worker_dyno_size
}
