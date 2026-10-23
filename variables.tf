variable "app_name" {
  type        = string
  description = "The name of the Heroku app for resource names and metric namespaces."
}

variable "app_fqdn" {
  type        = string
  description = "Deprecated and ignored: the module configures no CORS and names the Sidekiq namespace after heroku_app_name. Remove this argument from module calls."
  default     = null
}

variable "alert_email" {
  type        = string
  description = "The email address to receive CloudWatch alerts."
}

variable "lambda_source_path" {
  type        = string
  description = "Optional path to the Heroku logs Lambda source package directory. Defaults to this module's bundled support/lambda_heroku directory."
  default     = null
}

variable "resource_namespace" {
  type        = string
  description = "Optional namespace for account-scoped AWS resource names. Defaults to null to preserve the legacy un-namespaced names."
  default     = null

  validation {
    condition     = var.resource_namespace == null || trimspace(var.resource_namespace) == "" || can(regex("^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$", var.resource_namespace))
    error_message = "resource_namespace must be 1-40 characters and contain only letters, numbers, underscores, and hyphens."
  }
}

variable "enable_rack_attack_throttle_alert" {
  type        = bool
  description = "Enable SNS notifications for the Rack::Attack status=429 throttle alarm."
  default     = false
}

variable "log_metrics_without_alarm" {
  type        = list(string)
  description = "Log alarm keys, such as rack_attack_blocklist, whose metric filter stays for dashboards but which get no CloudWatch alarm. Use it for alarms that would sit in ALARM permanently for this app."
  default     = []

  validation {
    condition = alltrue([for key in var.log_metrics_without_alarm : contains([
      "api_401_unauthorized", "heroku_logplex_l10", "heroku_runtime_error",
      "poison_pill", "rack_attack_blocklist", "rack_attack_throttle", "redis_command_error",
      "sentry_error",
    ], key)])
    error_message = "log_metrics_without_alarm may only contain keys of the module's log alarms, such as rack_attack_blocklist."
  }
}

variable "enable_redis_load_avg_alert" {
  type        = bool
  description = "Deprecated and ignored: the Redis load average alarm measured the shared Redis host, not the add-on, and was removed. Remove this argument from module calls."
  default     = false
}

variable "heroku_app_id" {
  type        = string
  description = "The Heroku app ID to attach the log drain to."
}

variable "heroku_app_name" {
  type        = string
  description = "The Heroku app name, which Rails uses for the Sidekiq metric namespace. Defaults to app_name; set it when the Heroku app is named differently."
  default     = null
}

variable "metrics_app_name" {
  type        = string
  description = "The app's name in its metrics, as Grafana shows it: the App dimension of the metrics the log drain Lambda publishes (Heroku/Router, Heroku/Postgres, Heroku/Redis, Heroku/Dyno, Heroku/App) and the Heroku/<name>/... namespace of the log metric filters. Defaults to app_name; set it to name an app in Grafana without renaming the resources."
  default     = null
}

variable "log_bucket_arn" {
  type        = string
  description = "ARN of the S3 bucket used for raw Heroku log archival."
}

variable "pagerduty_aws_cloudwatch_integration_key" {
  type        = string
  description = "Deprecated and ignored: paging alerts moved to Grafana. Remove this argument from module calls."
  default     = null
  sensitive   = true
}

variable "observability_sink_arns" {
  type        = map(string)
  description = "CloudWatch cross-account observability sink ARNs by region. When the provider region has an entry, this account links its metrics to that sink. Defaults to {}, which creates no link."
  default     = {}
}

variable "redis_metrics_addon_names" {
  type        = list(string)
  description = "Names of the Heroku Redis add-ons whose samples are published as Heroku/Redis CloudWatch metrics, e.g. the primary Redis but not a cache. Each add-on is billed as two custom metrics. Defaults to [], which publishes none."
  default     = []
}

variable "heroku_logs_retention_in_days" {
  type        = number
  description = "Retention of the Heroku logs in CloudWatch Logs. Firehose archives the raw logs to S3 independently, so a shorter retention only limits how far back Logs Insights can search."
  default     = 60

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.heroku_logs_retention_in_days)
    error_message = "heroku_logs_retention_in_days must be a retention period that CloudWatch Logs supports, such as 14, 30 or 60."
  }
}

variable "lambda_reserved_concurrent_executions" {
  type        = number
  description = "Reserved concurrency of the log drain Lambda. Its Function URL is public and rejects unauthenticated requests only after being invoked, so a limit caps what a flood of requests costs. Set it well above the peak ConcurrentExecutions of the function, since throttled drain requests lose logs. Defaults to -1, which sets no limit."
  default     = -1
}
