# Links an account's CloudWatch metrics in the provider's region to a
# cross-account observability sink in the monitoring account.
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.28"
    }
  }
}

variable "sink_arn" {
  type        = string
  description = "ARN of the CloudWatch observability sink in the provider's region."
}

resource "aws_oam_link" "metrics" {
  label_template  = "$AccountName"
  resource_types  = ["AWS::CloudWatch::Metric"]
  sink_identifier = var.sink_arn
}

output "link_arn" {
  description = "ARN of the observability link."
  value       = aws_oam_link.metrics.arn
}
