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
  heroku_logs_log_group_name          = local.namespace == null ? "/heroku/logs" : "/heroku/${local.namespace}/logs"
  heroku_logs_log_stream_name         = local.namespace == null ? "heroku-logs-stream" : "${local.namespace}-heroku-logs-stream"
  lambda_function_name                = local.namespace == null ? "heroku-logs-lambda" : "${local.namespace}-heroku-logs-lambda"
}

# CloudWatch log groups
# -------------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "firehose_diagnostics" {
  name              = local.firehose_diagnostics_log_group_name
  retention_in_days = 60
}

resource "aws_cloudwatch_log_group" "heroku_logs" {
  name              = local.heroku_logs_log_group_name
  retention_in_days = 60
}

# IAM role for Kinesis Firehose
# -------------------------------------------------------------------------------
resource "aws_iam_role" "firehose_role" {
  name               = local.firehose_role_name
  assume_role_policy = data.aws_iam_policy_document.firehose_assume_role.json
}

data "aws_iam_policy_document" "firehose_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["firehose.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "firehose_policy" {
  statement {
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:AbortMultipartUpload",
      "s3:ListBucket",
      "s3:GetBucketLocation"
    ]
    resources = [
      var.log_bucket_arn,
      "${var.log_bucket_arn}/*"
    ]
  }
  statement {
    effect = "Allow"
    actions = [
      "logs:PutLogEvents",
      "logs:CreateLogStream",
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams"
    ]
    resources = [
      aws_cloudwatch_log_group.firehose_diagnostics.arn,
      "${aws_cloudwatch_log_group.firehose_diagnostics.arn}:*"
    ]
  }
}

resource "aws_iam_role_policy" "firehose_role_policy" {
  role   = aws_iam_role.firehose_role.id
  policy = data.aws_iam_policy_document.firehose_policy.json
}

# Kinesis Firehose delivery stream
# -------------------------------------------------------------------------------
resource "aws_kinesis_firehose_delivery_stream" "heroku_logs_stream" {
  name        = local.firehose_delivery_stream_name
  destination = "extended_s3"

  extended_s3_configuration {
    role_arn            = aws_iam_role.firehose_role.arn
    bucket_arn          = var.log_bucket_arn
    prefix              = local.firehose_s3_prefix       # S3 key prefix
    error_output_prefix = local.firehose_s3_error_prefix # S3 error prefix

    buffering_size     = 5  # MB
    buffering_interval = 60 # seconds

    compression_format = "GZIP"

    cloudwatch_logging_options {
      enabled         = true
      log_group_name  = aws_cloudwatch_log_group.firehose_diagnostics.name
      log_stream_name = local.firehose_log_stream_name
    }
  }
}

resource "random_string" "heroku_logs_lambda_basic_auth_username" {
  length  = 32
  special = false
}

resource "random_string" "heroku_logs_lambda_basic_auth_password" {
  length  = 32
  special = false
}

# Lambda function for heroku logs
# -------------------------------------------------------------------------------
module "heroku_logs_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = local.lambda_function_name
  description   = "Lambda function for ingesting Heroku logs, forwarding raw logs to Firehose for S3 archival and to CloudWatch Logs for real-time analysis"
  handler       = "lambda_heroku_logs_index.handler"
  runtime       = "nodejs22.x"

  # Package deterministic npm dependencies from package-lock.json and include the runtime files
  # needed to load the ESM handler, without re-zipping local node_modules from the working tree.
  source_path = [
    for claim in jsondecode(file("${local.lambda_source_path}/package_sources.json")) : {
      for key, value in claim :
      key => "${local.lambda_source_path}/${value}"
    }
  ]

  # Avoid repackaging on every apply when only the module's internal package timestamp changes.
  trigger_on_package_timestamp = false

  environment_variables = {
    FIREHOSE_STREAM_NAME = aws_kinesis_firehose_delivery_stream.heroku_logs_stream.name
    HEROKU_LOGS_GROUP    = aws_cloudwatch_log_group.heroku_logs.name
    HEROKU_LOGS_STREAM   = local.heroku_logs_log_stream_name
    AUTH_USERNAME        = random_string.heroku_logs_lambda_basic_auth_username.result # Note: Acceptable security trade-off to store this as cleartext
    AUTH_PASSWORD        = random_string.heroku_logs_lambda_basic_auth_password.result # Note: Acceptable security trade-off to store this as cleartext
  }

  memory_size   = 128
  timeout       = 10
  architectures = ["arm64"]

  # Enable Lambda Function URL
  create_lambda_function_url = true

  authorization_type = "NONE"
  cors = {
    allow_origins = ["https://${var.app_fqdn}"]
    allow_methods = ["POST"]
    allow_headers = ["content-type", "authorization"]
  }

  attach_cloudwatch_logs_policy = false # custom policy attached below
  attach_policy_json            = false
  attach_policy_statements      = true
  policy_statements = {
    heroku_logs_firehose = {
      actions = [
        "firehose:PutRecord",
        "firehose:PutRecordBatch"
      ]
      resources = [
        aws_kinesis_firehose_delivery_stream.heroku_logs_stream.arn
      ]
    },
    heroku_logs_cloudwatch = {
      actions = [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams"
      ]
      resources = [
        aws_cloudwatch_log_group.heroku_logs.arn,
        "${aws_cloudwatch_log_group.heroku_logs.arn}:*"
      ]
    }
  }
}

# Heroku drain configuration
# -------------------------------------------------------------------------------
resource "heroku_drain" "app_log_drain" {
  app_id = var.heroku_app_id

  url = "https://${random_string.heroku_logs_lambda_basic_auth_username.result}:${random_string.heroku_logs_lambda_basic_auth_password.result}@${trim(replace(module.heroku_logs_lambda.lambda_function_url, "https://", ""), "/")}"
}

# -------------------------------------------------------------------------------
# 1) SNS Topics for Alerts
# -------------------------------------------------------------------------------
resource "aws_sns_topic" "heroku_alerts" {
  name = "${var.app_name}-heroku-alerts"
}

resource "aws_sns_topic" "pagerduty_alerts" {
  name = "${var.app_name}-pagerduty-alerts"
}

# -- (a) Email subscription
resource "aws_sns_topic_subscription" "alert_email" {
  topic_arn = aws_sns_topic.heroku_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# -- (b) PagerDuty subscription
resource "aws_sns_topic_subscription" "pagerduty_subscription" {
  topic_arn = aws_sns_topic.pagerduty_alerts.arn
  protocol  = "https"

  endpoint = "https://events.pagerduty.com/x-ere/${var.pagerduty_aws_cloudwatch_integration_key}"

  raw_message_delivery   = false
  endpoint_auto_confirms = true
}

# -------------------------------------------------------------------------------
# 3) Log Metric Filters and Alarms
# -------------------------------------------------------------------------------
locals {
  namespace_prefix = "Heroku/${var.app_name}"
  alarm_period     = 60 # Period in seconds
}

# 1. used_memory_over_limit - Redis memory close to the limit
resource "aws_cloudwatch_log_metric_filter" "used_memory_over_limit" {
  name           = "${var.app_name}_used_memory_over_limit"
  log_group_name = aws_cloudwatch_log_group.heroku_logs.name

  pattern = "used_memory_over_limit"

  metric_transformation {
    name      = "UsedMemoryOverLimit"
    namespace = "${local.namespace_prefix}/Redis"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "used_memory_over_limit_alarm" {
  alarm_name          = "${var.app_name}_UsedMemoryOverLimit_Alarm"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.used_memory_over_limit.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.used_memory_over_limit.metric_transformation[0].namespace
  statistic           = "Sum"
  threshold           = 1
  period              = local.alarm_period
  alarm_description   = "Alert when Redis memory usage is close to the limit."
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
  ok_actions          = [aws_sns_topic.heroku_alerts.arn]
}

# 2. Redis::CommandError - Redis Error
resource "aws_cloudwatch_log_metric_filter" "redis_command_error" {
  name           = "${var.app_name}_RedisCommandError"
  log_group_name = aws_cloudwatch_log_group.heroku_logs.name

  pattern = "?\"Redis::CommandError\" ?\"redis critical\""

  metric_transformation {
    name      = "RedisCommandError"
    namespace = "${local.namespace_prefix}/Redis"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "redis_command_error_alarm" {
  alarm_name          = "${var.app_name}_RedisCommandError_Alarm"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.redis_command_error.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.redis_command_error.metric_transformation[0].namespace
  statistic           = "Sum"
  threshold           = 1
  period              = local.alarm_period
  alarm_description   = "Alert on Redis command errors."
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
}

# 3. Redis Load Average - "redis load-avg" excluding zero load averages
resource "aws_cloudwatch_log_metric_filter" "redis_load_avg" {
  count = var.enable_redis_load_avg_alert ? 1 : 0

  name           = "${var.app_name}_RedisLoadAvg"
  log_group_name = aws_cloudwatch_log_group.heroku_logs.name

  pattern = "redis \"load-avg\" -\"load-avg-1m=0\" -\"load-avg-5m=0\""

  metric_transformation {
    name      = "RedisLoadAverage"
    namespace = "${local.namespace_prefix}/Redis"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "redis_load_avg_alarm" {
  count = var.enable_redis_load_avg_alert ? 1 : 0

  alarm_name          = "${var.app_name}_RedisLoadAvg_Alarm"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.redis_load_avg[0].metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.redis_load_avg[0].metric_transformation[0].namespace
  statistic           = "Sum"
  threshold           = 10
  period              = 300
  alarm_description   = "Alert when Redis load average is non-zero repeatedly."
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
  ok_actions          = [aws_sns_topic.heroku_alerts.arn]
}

# 4. Heroku HTTP error - code=H* excluding specific codes
resource "aws_cloudwatch_log_metric_filter" "heroku_http_error" {
  name           = "${var.app_name}_HerokuHTTPError"
  log_group_name = aws_cloudwatch_log_group.heroku_logs.name

  pattern = "code=H -code=H27 -code=H31 -code=H32 -code=H28 -code=H80 -code=H99"

  metric_transformation {
    name      = "HerokuHTTPError"
    namespace = "${local.namespace_prefix}/HTTP"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "heroku_http_error_alarm" {
  alarm_name          = "${var.app_name}_HerokuHTTPError_Alarm"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.heroku_http_error.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.heroku_http_error.metric_transformation[0].namespace
  statistic           = "Sum"
  threshold           = 5
  period              = local.alarm_period
  alarm_description   = "Alert on specific Heroku HTTP error codes excluding H27, H31, H32, H28, H80, H99 when there are 5 or more errors in the period."
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
}

# 5. Heroku Runtime Error - "Error R" excluding R14
resource "aws_cloudwatch_log_metric_filter" "heroku_runtime_error" {
  name           = "${var.app_name}_HerokuRuntimeError"
  log_group_name = aws_cloudwatch_log_group.heroku_logs.name

  pattern = "\"Error R\" -R14 -R99 -\"(Exit timeout)\""

  metric_transformation {
    name      = "HerokuRuntimeError"
    namespace = "${local.namespace_prefix}/Runtime"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "heroku_runtime_error_alarm" {
  alarm_name          = "${var.app_name}_HerokuRuntimeError_Alarm"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.heroku_runtime_error.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.heroku_runtime_error.metric_transformation[0].namespace
  statistic           = "Sum"
  threshold           = 1
  period              = local.alarm_period
  alarm_description   = "Alert on Heroku runtime errors excluding R14 and R99."
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
}

# 6. Poison Pill - Poison pill killed by Sidekiq
resource "aws_cloudwatch_log_metric_filter" "poison_pill" {
  name           = "${var.app_name}_PoisonPill"
  log_group_name = aws_cloudwatch_log_group.heroku_logs.name

  pattern = "\"poison pill\""

  metric_transformation {
    name      = "PoisonPillKilled"
    namespace = "${local.namespace_prefix}/Sidekiq"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "poison_pill_alarm" {
  alarm_name          = "${var.app_name}_PoisonPill_Alarm"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.poison_pill.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.poison_pill.metric_transformation[0].namespace
  statistic           = "Sum"
  threshold           = 1
  period              = local.alarm_period
  alarm_description   = "Alert when a poison pill is killed by Sidekiq."
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
}

# 7. Sidekiq Queue Latency - monitor queue latency from custom metric
resource "aws_cloudwatch_metric_alarm" "sidekiq_queue_latency_alarm" {
  alarm_name          = "${var.app_name}_SidekiqQueueLatency_Alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "QueueLatency"
  namespace           = "${var.app_fqdn}/Sidekiq"
  statistic           = "Maximum"
  threshold           = 60
  period              = 600
  alarm_description   = "Alert when Sidekiq queue latency exceeds 60 seconds."
  alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
  ok_actions          = [aws_sns_topic.heroku_alerts.arn]
  treat_missing_data  = "notBreaching"
}

# 8. Rack::Attack Throttling - status=429 excluding agentmon
resource "aws_cloudwatch_log_metric_filter" "rack_attack_throttle" {
  name           = "${var.app_name}_RackAttackThrottle"
  log_group_name = aws_cloudwatch_log_group.heroku_logs.name

  pattern = "status=429 -agentmon"

  metric_transformation {
    name      = "RackAttackThrottle"
    namespace = "${local.namespace_prefix}/Security"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "rack_attack_throttle_alarm" {
  alarm_name          = "${var.app_name}_RackAttackThrottle_Alarm"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.rack_attack_throttle.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.rack_attack_throttle.metric_transformation[0].namespace
  statistic           = "Sum"
  threshold           = 50
  period              = 60
  alarm_description   = "Alert on Rack::Attack IP throttling (status=429) excluding agentmon."
  actions_enabled     = var.enable_rack_attack_throttle_alert
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
}

# 9. Postgres Load Average - "postgres load-avg" excluding specific load averages
resource "aws_cloudwatch_log_metric_filter" "postgres_load_avg" {
  name           = "${var.app_name}_PostgresLoadAvg"
  log_group_name = aws_cloudwatch_log_group.heroku_logs.name

  pattern = "postgres \"sample#load-avg\" -\"sample#load-avg-1m=0\" -\"sample#load-avg-5m=0\""

  metric_transformation {
    name      = "PostgresLoadAverage"
    namespace = "${local.namespace_prefix}/Postgres"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "postgres_load_avg_alarm" {
  alarm_name          = "${var.app_name}_PostgresLoadAvg_Alarm"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.postgres_load_avg.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.postgres_load_avg.metric_transformation[0].namespace
  statistic           = "Sum"
  threshold           = 10
  period              = 300
  alarm_description   = "Alert when Postgres load average exceeds thresholds."
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
  ok_actions          = [aws_sns_topic.heroku_alerts.arn]
}

# 10. Sentry Error - "ERROR -- sentry:"
resource "aws_cloudwatch_log_metric_filter" "sentry_error" {
  name           = "${var.app_name}_SentryError"
  log_group_name = aws_cloudwatch_log_group.heroku_logs.name

  pattern = "\"ERROR -- sentry:\""

  metric_transformation {
    name      = "SentryError"
    namespace = "${local.namespace_prefix}/Sentry"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "sentry_error_alarm" {
  alarm_name          = "${var.app_name}_SentryError_Alarm"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.sentry_error.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.sentry_error.metric_transformation[0].namespace
  statistic           = "Sum"
  threshold           = 1
  period              = local.alarm_period
  alarm_description   = "Alert when a Sentry error is detected in the logs."
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
}

# 11. postgresql type_map initialization race condition https://github.com/rails/rails/issues/51780
resource "aws_cloudwatch_log_metric_filter" "postgres_race_condition" {
  name           = "${var.app_name}_PostgresRaceCondition"
  log_group_name = aws_cloudwatch_log_group.heroku_logs.name

  pattern = "\"undefined method 'key?' for nil\""

  metric_transformation {
    name      = "PostgresRaceCondition"
    namespace = "${local.namespace_prefix}/PostgresRaceCondition"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "postgres_race_condition_alarm" {
  alarm_name          = "${var.app_name}_PostgresRaceCondition_Alarm"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.postgres_race_condition.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.postgres_race_condition.metric_transformation[0].namespace
  statistic           = "Sum"
  threshold           = 1
  period              = local.alarm_period
  alarm_description   = "Alert when a possible race condition in PostgreSQL type_map initialization is detected."
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.pagerduty_alerts.arn]
}
