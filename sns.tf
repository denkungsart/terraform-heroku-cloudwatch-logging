# SNS Topics for Alerts
# -------------------------------------------------------------------------------
resource "aws_sns_topic" "heroku_alerts" {
  name = "${var.app_name}-heroku-alerts"
}

resource "aws_sns_topic_subscription" "alert_email" {
  topic_arn = aws_sns_topic.heroku_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}
