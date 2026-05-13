# SNS Topics for Alerts
# -------------------------------------------------------------------------------
resource "aws_sns_topic" "heroku_alerts" {
  name = "${var.app_name}-heroku-alerts"
}

resource "aws_sns_topic" "pagerduty_alerts" {
  name = "${var.app_name}-pagerduty-alerts"
}

resource "aws_sns_topic_subscription" "alert_email" {
  topic_arn = aws_sns_topic.heroku_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_sns_topic_subscription" "pagerduty_subscription" {
  topic_arn = aws_sns_topic.pagerduty_alerts.arn
  protocol  = "https"

  endpoint = "https://events.pagerduty.com/x-ere/${var.pagerduty_aws_cloudwatch_integration_key}"

  raw_message_delivery   = false
  endpoint_auto_confirms = true
}
