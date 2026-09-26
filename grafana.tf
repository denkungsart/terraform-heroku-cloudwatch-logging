# Cross-account CloudWatch metrics read access for Amazon Managed Grafana
# -------------------------------------------------------------------------------
resource "aws_iam_role" "grafana_cloudwatch_read" {
  count = var.grafana_workspace_role_arn == null ? 0 : 1

  name               = local.grafana_cloudwatch_read_role_name
  assume_role_policy = data.aws_iam_policy_document.grafana_cloudwatch_read_assume_role[0].json
}

data "aws_iam_policy_document" "grafana_cloudwatch_read_assume_role" {
  count = var.grafana_workspace_role_arn == null ? 0 : 1

  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = [var.grafana_workspace_role_arn]
    }
  }
}

# Metrics only: Grafana gets no access to the Heroku log contents.
data "aws_iam_policy_document" "grafana_cloudwatch_read" {
  statement {
    effect = "Allow"
    actions = [
      "cloudwatch:DescribeAlarmHistory",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:DescribeAlarmsForMetric",
      "cloudwatch:GetMetricData",
      "cloudwatch:GetMetricStatistics",
      "cloudwatch:ListMetrics",
      "ec2:DescribeRegions"
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "grafana_cloudwatch_read" {
  count = var.grafana_workspace_role_arn == null ? 0 : 1

  role   = aws_iam_role.grafana_cloudwatch_read[0].id
  policy = data.aws_iam_policy_document.grafana_cloudwatch_read.json
}
