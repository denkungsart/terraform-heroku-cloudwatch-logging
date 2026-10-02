# CloudWatch cross-account observability
# -------------------------------------------------------------------------------
# Shares this account's metrics with the monitoring account sink in the same
# region, so one Grafana workspace can query all installations.
data "aws_region" "current" {}

locals {
  observability_sink_arn = lookup(var.observability_sink_arns, data.aws_region.current.region, null)
}

resource "aws_oam_link" "metrics" {
  count = local.observability_sink_arn == null ? 0 : 1

  label_template  = "$AccountName"
  resource_types  = ["AWS::CloudWatch::Metric"]
  sink_identifier = local.observability_sink_arn
}
