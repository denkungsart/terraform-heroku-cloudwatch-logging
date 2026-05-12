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
