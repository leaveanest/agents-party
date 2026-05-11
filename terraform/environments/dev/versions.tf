terraform {
  required_version = ">= 1.7.0"

  required_providers {
    heroku = {
      source  = "heroku/heroku"
      version = "~> 5.0"
    }
  }
}

provider "heroku" {
  customizations {
    set_app_all_config_vars_in_state = false
    set_addon_config_vars_in_state   = false
  }
}
