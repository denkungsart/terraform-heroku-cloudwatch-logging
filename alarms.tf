# Log Metric Filters and Alarms
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

# 6. Heroku Logplex Drain Buffer Overflow - dropped log messages
resource "aws_cloudwatch_log_metric_filter" "heroku_logplex_l10" {
  name           = "${var.app_name}_HerokuLogplexL10"
  log_group_name = aws_cloudwatch_log_group.heroku_logs.name

  pattern = "\"Error L10\" \"output buffer overflow\""

  metric_transformation {
    name      = "HerokuLogplexL10"
    namespace = "${local.namespace_prefix}/Logplex"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "heroku_logplex_l10_alarm" {
  alarm_name          = "${var.app_name}_HerokuLogplexL10_Alarm"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.heroku_logplex_l10.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.heroku_logplex_l10.metric_transformation[0].namespace
  statistic           = "Sum"
  threshold           = 1
  period              = local.alarm_period
  alarm_description   = "Alert when Heroku Logplex reports L10 drain buffer overflow events, indicating dropped log messages."
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
  ok_actions          = [aws_sns_topic.heroku_alerts.arn]
}

# 7. Poison Pill - Poison pill killed by Sidekiq
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

# 8. Sidekiq Queue Latency - monitor queue latency from custom metric
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

# 9. Rack::Attack Throttling - status=429 excluding agentmon
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

# 10. Rack::Attack Blocklist - Rack::Attack blocked requests
resource "aws_cloudwatch_log_metric_filter" "rack_attack_blocklist" {
  name           = "${var.app_name}_RackAttackBlocklist"
  log_group_name = aws_cloudwatch_log_group.heroku_logs.name

  pattern = "\"Rack::Attack\" blocklist"

  metric_transformation {
    name      = "RackAttackBlocklist"
    namespace = "${local.namespace_prefix}/Security"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "rack_attack_blocklist_alarm" {
  alarm_name          = "${var.app_name}_RackAttackBlocklist_Alarm"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.rack_attack_blocklist.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.rack_attack_blocklist.metric_transformation[0].namespace
  statistic           = "Sum"
  threshold           = 10
  period              = 86400
  alarm_description   = "Alert when Rack::Attack blocklist logs reach 10 or more in one day."
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
}

# 11. API 401 Unauthorized - repeated unauthorized API requests
resource "aws_cloudwatch_log_metric_filter" "api_401_unauthorized" {
  name           = "${var.app_name}_Api401Unauthorized"
  log_group_name = aws_cloudwatch_log_group.heroku_logs.name

  pattern = "\"/api/v1\" \"status=401\""

  metric_transformation {
    name      = "Api401Unauthorized"
    namespace = "${local.namespace_prefix}/Security"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_401_unauthorized_alarm" {
  alarm_name          = "${var.app_name}_Api401Unauthorized_Alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.api_401_unauthorized.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.api_401_unauthorized.metric_transformation[0].namespace
  statistic           = "Sum"
  threshold           = 100
  period              = 3600
  alarm_description   = "Alert when API v1 401 responses exceed 100 in one hour."
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
}

# 12. Postgres Load Average - "postgres load-avg" excluding specific load averages
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

# 13. Sentry Error - "ERROR -- sentry:"
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

# 14. postgresql type_map initialization race condition https://github.com/rails/rails/issues/51780
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
