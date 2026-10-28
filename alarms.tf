# Log Metric Filters
# -------------------------------------------------------------------------------
# The filters only feed metrics. Grafana alert rules in the monitoring account
# alert on them, and dashboards show them.
locals {
  namespace_prefix = "Heroku/${local.metrics_app_name}"

  log_metric_filters = {
    used_memory_over_limit = {
      filter_name      = "${var.app_name}_used_memory_over_limit"
      pattern          = "used_memory_over_limit"
      metric_name      = "UsedMemoryOverLimit"
      metric_namespace = "${local.namespace_prefix}/Redis"
    }

    redis_command_error = {
      filter_name      = "${var.app_name}_RedisCommandError"
      pattern          = "?\"Redis::CommandError\" ?\"redis critical\""
      metric_name      = "RedisCommandError"
      metric_namespace = "${local.namespace_prefix}/Redis"
    }

    # Excluded Heroku router codes: H27 client request interrupted, H28 client
    # connection idle, H31 misdirected request, H32 TLS certificate mismatch,
    # H80 maintenance mode, and H99 platform error.
    heroku_http_error = {
      filter_name      = "${var.app_name}_HerokuHTTPError"
      pattern          = "code=H -code=H27 -code=H31 -code=H32 -code=H28 -code=H80 -code=H99"
      metric_name      = "HerokuHTTPError"
      metric_namespace = "${local.namespace_prefix}/HTTP"
    }

    heroku_runtime_error = {
      filter_name      = "${var.app_name}_HerokuRuntimeError"
      pattern          = "\"Error R\" -R14 -R99 -\"(Exit timeout)\""
      metric_name      = "HerokuRuntimeError"
      metric_namespace = "${local.namespace_prefix}/Runtime"
    }

    heroku_logplex_l10 = {
      filter_name      = "${var.app_name}_HerokuLogplexL10"
      pattern          = "\"Error L10\" \"output buffer overflow\""
      metric_name      = "HerokuLogplexL10"
      metric_namespace = "${local.namespace_prefix}/Logplex"
    }

    poison_pill = {
      filter_name      = "${var.app_name}_PoisonPill"
      pattern          = "\"poison pill\""
      metric_name      = "PoisonPillKilled"
      metric_namespace = "${local.namespace_prefix}/Sidekiq"
    }

    rack_attack_throttle = {
      filter_name      = "${var.app_name}_RackAttackThrottle"
      pattern          = "status=429 -agentmon"
      metric_name      = "RackAttackThrottle"
      metric_namespace = "${local.namespace_prefix}/Security"
    }

    api_401_unauthorized = {
      filter_name      = "${var.app_name}_Api401Unauthorized"
      pattern          = "\"/api/v1\" \"status=401\""
      metric_name      = "Api401Unauthorized"
      metric_namespace = "${local.namespace_prefix}/Security"
    }

    sentry_error = {
      filter_name      = "${var.app_name}_SentryError"
      pattern          = "\"ERROR -- sentry:\""
      metric_name      = "SentryError"
      metric_namespace = "${local.namespace_prefix}/Sentry"
    }

    # Puma answers a request over one of its length limits (query string 10 KB,
    # URI 12 KB, path 8 KB, headers) with an empty 400 before the app sees it,
    # so neither the app nor Sentry reports it. Its other rejections, malformed
    # requests and unsupported methods, come from scanners and broken clients.
    puma_request_too_long = {
      filter_name      = "${var.app_name}_PumaRequestTooLong"
      pattern          = "\"is longer than the\" \"allowed length\""
      metric_name      = "PumaRequestTooLong"
      metric_namespace = "${local.namespace_prefix}/Puma"
    }

    postgres_race_condition = {
      filter_name      = "${var.app_name}_PostgresRaceCondition"
      pattern          = "\"undefined method 'key?' for nil\""
      metric_name      = "PostgresRaceCondition"
      metric_namespace = "${local.namespace_prefix}/PostgresRaceCondition"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "log_alarm" {
  for_each = local.log_metric_filters

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
  dimensions          = { App = local.metrics_app_name }
  statistic           = "Sum"
  threshold           = 1
  period              = 300
  alarm_description   = "Alert when the log drain Lambda publishes no Heroku router metrics for 30 minutes."
  alarm_actions       = [aws_sns_topic.heroku_alerts.arn]
  ok_actions          = [aws_sns_topic.heroku_alerts.arn]
  treat_missing_data  = "breaching"
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

