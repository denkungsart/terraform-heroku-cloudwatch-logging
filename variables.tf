variable "app_name" {
  type        = string
  description = "The name of the Heroku app for resource names and metric namespaces."
}

variable "app_fqdn" {
  type        = string
  description = "The fully qualified app domain used for Lambda Function URL CORS and Sidekiq metric namespace."
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
  description = "Names of the Heroku Redis add-ons whose samples are published as Heroku/Redis CloudWatch metrics, e.g. the primary Redis but not a cache. Each add-on is billed as five custom metrics. Defaults to [], which publishes none."
  default     = []
}
