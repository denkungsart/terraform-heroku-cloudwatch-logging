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

variable "heroku_app_id" {
  type        = string
  description = "The Heroku app ID to attach the log drain to."
}

variable "log_bucket_arn" {
  type        = string
  description = "ARN of the S3 bucket used for raw Heroku log archival."
}

variable "pagerduty_aws_cloudwatch_integration_key" {
  type        = string
  sensitive   = true
  description = "Service integration identifier used by PagerDuty for CloudWatch alerts."
}
