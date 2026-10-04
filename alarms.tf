# Log Metric Filters and Alarms
# -------------------------------------------------------------------------------
locals {
  namespace_prefix = "Heroku/${var.app_name}"
  alarm_period     = 60 # Period in seconds

  log_metric_alarms = {
    used_memory_over_limit = {
      enabled             = true
      filter_name         = "${var.app_name}_used_memory_over_limit"
      pattern             = "used_memory_over_limit"
      metric_name         = "UsedMemoryOverLimit"
      metric_namespace    = "${local.namespace_prefix}/Redis"
      alarm_name          = "${var.app_name}_UsedMemoryOverLimit_Alarm"
      comparison_operator = "GreaterThanOrEqualToThreshold"
      threshold           = 1
      period              = local.alarm_period
      description         = "Alert when Redis memory usage is close to the limit."
      alarm_actions       = []
      ok_actions          = null
      actions_enabled     = null
    }

    redis_command_error = {
      enabled             = true
      filter_name         = "${var.app_name}_RedisCommandError"
      pattern             = "?\"Redis::CommandError\" ?\"redis critical\""
      metric_name         = "RedisCommandError"
      metric_namespace    = "${local.namespace_prefix}/Redis"
      alarm_name          = "${var.app_name}_RedisCommandError_Alarm"
      comparison_operator = "GreaterThanOrEqualToThreshold"
      threshold           = 1
      period              = local.alarm_period
      description         = "Alert on Redis command errors."
      alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
      ok_actions          = null
      actions_enabled     = null
    }

    # Excluded Heroku router codes: H27 client request interrupted, H28 client
    # connection idle, H31 misdirected request, H32 TLS certificate mismatch,
    # H80 maintenance mode, and H99 platform error.
    heroku_http_error = {
      enabled             = true
      filter_name         = "${var.app_name}_HerokuHTTPError"
      pattern             = "code=H -code=H27 -code=H31 -code=H32 -code=H28 -code=H80 -code=H99"
      metric_name         = "HerokuHTTPError"
      metric_namespace    = "${local.namespace_prefix}/HTTP"
      alarm_name          = "${var.app_name}_HerokuHTTPError_Alarm"
      comparison_operator = "GreaterThanOrEqualToThreshold"
      threshold           = 5
      period              = local.alarm_period
      description         = "Alert on specific Heroku HTTP error codes excluding H27, H31, H32, H28, H80, H99 when there are 5 or more errors in the period."
      alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
      ok_actions          = null
      actions_enabled     = null
    }

    heroku_runtime_error = {
      enabled             = true
      filter_name         = "${var.app_name}_HerokuRuntimeError"
      pattern             = "\"Error R\" -R14 -R99 -\"(Exit timeout)\""
      metric_name         = "HerokuRuntimeError"
      metric_namespace    = "${local.namespace_prefix}/Runtime"
      alarm_name          = "${var.app_name}_HerokuRuntimeError_Alarm"
      comparison_operator = "GreaterThanOrEqualToThreshold"
      threshold           = 1
      period              = local.alarm_period
      description         = "Alert on Heroku runtime errors excluding R14 and R99."
      alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
      ok_actions          = null
      actions_enabled     = null
    }

    heroku_logplex_l10 = {
      enabled             = true
      filter_name         = "${var.app_name}_HerokuLogplexL10"
      pattern             = "\"Error L10\" \"output buffer overflow\""
      metric_name         = "HerokuLogplexL10"
      metric_namespace    = "${local.namespace_prefix}/Logplex"
      alarm_name          = "${var.app_name}_HerokuLogplexL10_Alarm"
      comparison_operator = "GreaterThanOrEqualToThreshold"
      threshold           = 1
      period              = local.alarm_period
      description         = "Alert when Heroku Logplex reports L10 drain buffer overflow events, indicating dropped log messages."
      alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
      ok_actions          = [aws_sns_topic.heroku_alerts.arn]
      actions_enabled     = null
    }

    poison_pill = {
      enabled             = true
      filter_name         = "${var.app_name}_PoisonPill"
      pattern             = "\"poison pill\""
      metric_name         = "PoisonPillKilled"
      metric_namespace    = "${local.namespace_prefix}/Sidekiq"
      alarm_name          = "${var.app_name}_PoisonPill_Alarm"
      comparison_operator = "GreaterThanOrEqualToThreshold"
      threshold           = 1
      period              = local.alarm_period
      description         = "Alert when a poison pill is killed by Sidekiq."
      alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
      ok_actions          = null
      actions_enabled     = null
    }

    rack_attack_throttle = {
      enabled             = true
      filter_name         = "${var.app_name}_RackAttackThrottle"
      pattern             = "status=429 -agentmon"
      metric_name         = "RackAttackThrottle"
      metric_namespace    = "${local.namespace_prefix}/Security"
      alarm_name          = "${var.app_name}_RackAttackThrottle_Alarm"
      comparison_operator = "GreaterThanOrEqualToThreshold"
      threshold           = 50
      period              = 60
      description         = "Alert on Rack::Attack IP throttling (status=429) excluding agentmon."
      alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
      ok_actions          = null
      actions_enabled     = var.enable_rack_attack_throttle_alert
    }

    rack_attack_blocklist = {
      enabled             = true
      filter_name         = "${var.app_name}_RackAttackBlocklist"
      pattern             = "\"Rack::Attack\" blocklist"
      metric_name         = "RackAttackBlocklist"
      metric_namespace    = "${local.namespace_prefix}/Security"
      alarm_name          = "${var.app_name}_RackAttackBlocklist_Alarm"
      comparison_operator = "GreaterThanOrEqualToThreshold"
      threshold           = 10
      period              = 86400
      description         = "Alert when Rack::Attack blocklist logs reach 10 or more in one day."
      alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
      ok_actions          = null
      actions_enabled     = null
    }

    api_401_unauthorized = {
      enabled             = true
      filter_name         = "${var.app_name}_Api401Unauthorized"
      pattern             = "\"/api/v1\" \"status=401\""
      metric_name         = "Api401Unauthorized"
      metric_namespace    = "${local.namespace_prefix}/Security"
      alarm_name          = "${var.app_name}_Api401Unauthorized_Alarm"
      comparison_operator = "GreaterThanThreshold"
      threshold           = 100
      period              = 3600
      description         = "Alert when API v1 401 responses exceed 100 in one hour."
      alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
      ok_actions          = null
      actions_enabled     = null
    }

    sentry_error = {
      enabled             = true
      filter_name         = "${var.app_name}_SentryError"
      pattern             = "\"ERROR -- sentry:\""
      metric_name         = "SentryError"
      metric_namespace    = "${local.namespace_prefix}/Sentry"
      alarm_name          = "${var.app_name}_SentryError_Alarm"
      comparison_operator = "GreaterThanOrEqualToThreshold"
      threshold           = 1
      period              = local.alarm_period
      description         = "Alert when a Sentry error is detected in the logs."
      alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
      ok_actions          = null
      actions_enabled     = null
    }

    postgres_race_condition = {
      enabled             = true
      filter_name         = "${var.app_name}_PostgresRaceCondition"
      pattern             = "\"undefined method 'key?' for nil\""
      metric_name         = "PostgresRaceCondition"
      metric_namespace    = "${local.namespace_prefix}/PostgresRaceCondition"
      alarm_name          = "${var.app_name}_PostgresRaceCondition_Alarm"
      comparison_operator = "GreaterThanOrEqualToThreshold"
      threshold           = 1
      period              = local.alarm_period
      description         = "Alert when a possible race condition in PostgreSQL type_map initialization is detected."
      alarm_actions       = []
      ok_actions          = null
      actions_enabled     = null
    }
  }

  # Paged by Grafana alert rules of the same name, which read the metrics of
  # these filters. They have no CloudWatch alarm here.
  grafana_paged_log_metrics = ["used_memory_over_limit", "postgres_race_condition"]

  enabled_log_metric_alarms = {
    for key, alarm in local.log_metric_alarms : key => alarm if alarm.enabled
  }
}

resource "aws_cloudwatch_log_metric_filter" "log_alarm" {
  for_each = local.enabled_log_metric_alarms

  name           = each.value.filter_name
  log_group_name = aws_cloudwatch_log_group.heroku_logs.name
  pattern        = each.value.pattern

  metric_transformation {
    name      = each.value.metric_name
    namespace = each.value.metric_namespace
    value     = "1"
    unit      = "Count"
  }
}

# Some metric filters only feed Grafana alert rules and have no alarm here.
resource "aws_cloudwatch_metric_alarm" "log_alarm" {
  for_each = { for key, alarm in local.enabled_log_metric_alarms : key => alarm if !contains(local.grafana_paged_log_metrics, key) }

  alarm_name          = each.value.alarm_name
  comparison_operator = each.value.comparison_operator
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.log_alarm[each.key].metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.log_alarm[each.key].metric_transformation[0].namespace
  statistic           = "Sum"
  threshold           = each.value.threshold
  period              = each.value.period
  alarm_description   = each.value.description
  actions_enabled     = each.value.actions_enabled
  treat_missing_data  = "notBreaching"
  alarm_actions       = each.value.alarm_actions
  ok_actions          = each.value.ok_actions
}

# Route53 health checks reach every app around the clock, so missing router
# metrics mean the log drain, the Lambda or metric publishing is broken. This
# alarm lives in the account, so it works even when Grafana or the
# observability link does not.
resource "aws_cloudwatch_metric_alarm" "heroku_metrics_missing_alarm" {
  alarm_name          = "${var.app_name}_HerokuMetricsMissing_Alarm"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 6
  metric_name         = "Requests"
  namespace           = "Heroku/Router"
  dimensions          = { App = var.app_name }
  statistic           = "Sum"
  threshold           = 1
  period              = 300
  alarm_description   = "Alert when the log drain Lambda publishes no Heroku router metrics for 30 minutes."
  alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
  ok_actions          = [aws_sns_topic.heroku_alerts.arn]
  treat_missing_data  = "breaching"
}

resource "aws_cloudwatch_metric_alarm" "sidekiq_queue_latency_app_name_alarm" {
  alarm_name          = "${var.app_name}_SidekiqQueueLatencyAppName_Alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "QueueLatency"
  namespace           = "${coalesce(var.heroku_app_name, var.app_name)}/Sidekiq"
  statistic           = "Maximum"
  threshold           = 60
  period              = 600
  alarm_description   = "Alert when Sidekiq queue latency exceeds 60 seconds in the Heroku app name namespace."
  alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
  ok_actions          = [aws_sns_topic.heroku_alerts.arn]
  treat_missing_data  = "notBreaching"
}

moved {
  from = aws_cloudwatch_log_metric_filter.used_memory_over_limit
  to   = aws_cloudwatch_log_metric_filter.log_alarm["used_memory_over_limit"]
}

moved {
  from = aws_cloudwatch_log_metric_filter.redis_command_error
  to   = aws_cloudwatch_log_metric_filter.log_alarm["redis_command_error"]
}

moved {
  from = aws_cloudwatch_log_metric_filter.heroku_http_error
  to   = aws_cloudwatch_log_metric_filter.log_alarm["heroku_http_error"]
}

moved {
  from = aws_cloudwatch_log_metric_filter.heroku_runtime_error
  to   = aws_cloudwatch_log_metric_filter.log_alarm["heroku_runtime_error"]
}

moved {
  from = aws_cloudwatch_log_metric_filter.heroku_logplex_l10
  to   = aws_cloudwatch_log_metric_filter.log_alarm["heroku_logplex_l10"]
}

moved {
  from = aws_cloudwatch_log_metric_filter.poison_pill
  to   = aws_cloudwatch_log_metric_filter.log_alarm["poison_pill"]
}

moved {
  from = aws_cloudwatch_log_metric_filter.rack_attack_throttle
  to   = aws_cloudwatch_log_metric_filter.log_alarm["rack_attack_throttle"]
}

moved {
  from = aws_cloudwatch_log_metric_filter.rack_attack_blocklist
  to   = aws_cloudwatch_log_metric_filter.log_alarm["rack_attack_blocklist"]
}

moved {
  from = aws_cloudwatch_log_metric_filter.api_401_unauthorized
  to   = aws_cloudwatch_log_metric_filter.log_alarm["api_401_unauthorized"]
}

moved {
  from = aws_cloudwatch_log_metric_filter.sentry_error
  to   = aws_cloudwatch_log_metric_filter.log_alarm["sentry_error"]
}

moved {
  from = aws_cloudwatch_log_metric_filter.postgres_race_condition
  to   = aws_cloudwatch_log_metric_filter.log_alarm["postgres_race_condition"]
}

moved {
  from = aws_cloudwatch_metric_alarm.redis_command_error_alarm
  to   = aws_cloudwatch_metric_alarm.log_alarm["redis_command_error"]
}

moved {
  from = aws_cloudwatch_metric_alarm.heroku_http_error_alarm
  to   = aws_cloudwatch_metric_alarm.log_alarm["heroku_http_error"]
}

moved {
  from = aws_cloudwatch_metric_alarm.heroku_runtime_error_alarm
  to   = aws_cloudwatch_metric_alarm.log_alarm["heroku_runtime_error"]
}

moved {
  from = aws_cloudwatch_metric_alarm.heroku_logplex_l10_alarm
  to   = aws_cloudwatch_metric_alarm.log_alarm["heroku_logplex_l10"]
}

moved {
  from = aws_cloudwatch_metric_alarm.poison_pill_alarm
  to   = aws_cloudwatch_metric_alarm.log_alarm["poison_pill"]
}

moved {
  from = aws_cloudwatch_metric_alarm.rack_attack_throttle_alarm
  to   = aws_cloudwatch_metric_alarm.log_alarm["rack_attack_throttle"]
}

moved {
  from = aws_cloudwatch_metric_alarm.rack_attack_blocklist_alarm
  to   = aws_cloudwatch_metric_alarm.log_alarm["rack_attack_blocklist"]
}

moved {
  from = aws_cloudwatch_metric_alarm.api_401_unauthorized_alarm
  to   = aws_cloudwatch_metric_alarm.log_alarm["api_401_unauthorized"]
}

moved {
  from = aws_cloudwatch_metric_alarm.sentry_error_alarm
  to   = aws_cloudwatch_metric_alarm.log_alarm["sentry_error"]
}

