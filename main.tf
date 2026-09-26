# Logging pipeline that ingests Heroku logs
# -------------------------------------------------------------------------------

locals {
  lambda_source_path = coalesce(var.lambda_source_path, "${path.module}/support/lambda_heroku")
  namespace          = var.resource_namespace == null || trimspace(var.resource_namespace) == "" ? null : trimspace(var.resource_namespace)

  firehose_diagnostics_log_group_name = local.namespace == null ? "/firehose/diagnostics" : "/firehose/${local.namespace}/diagnostics"
  firehose_delivery_stream_name       = local.namespace == null ? "heroku-logs-delivery" : "${local.namespace}-heroku-logs-delivery"
  firehose_log_stream_name            = local.namespace == null ? "firehose-delivery-stream" : "${local.namespace}-firehose-delivery-stream"
  firehose_role_name                  = local.namespace == null ? "firehose_delivery_role" : "${local.namespace}-firehose-delivery-role"
  firehose_s3_error_prefix            = local.namespace == null ? "heroku-logs-error/" : "heroku-logs-error/${local.namespace}/"
  firehose_s3_prefix                  = local.namespace == null ? "heroku-logs/" : "heroku-logs/${local.namespace}/"
  grafana_cloudwatch_read_role_name   = local.namespace == null ? "grafana-cloudwatch-read" : "${local.namespace}-grafana-cloudwatch-read"
  heroku_logs_log_group_name          = local.namespace == null ? "/heroku/logs" : "/heroku/${local.namespace}/logs"
  heroku_logs_log_stream_name         = local.namespace == null ? "heroku-logs-stream" : "${local.namespace}-heroku-logs-stream"
  heroku_metrics_log_group_name       = local.namespace == null ? "/heroku/metrics" : "/heroku/${local.namespace}/metrics"
  heroku_metrics_log_stream_name      = local.namespace == null ? "heroku-postgres-metrics" : "${local.namespace}-heroku-postgres-metrics"
  lambda_function_name                = local.namespace == null ? "heroku-logs-lambda" : "${local.namespace}-heroku-logs-lambda"
}
