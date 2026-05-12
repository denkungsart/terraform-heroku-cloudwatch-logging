# Heroku CloudWatch Logging Terraform Module

Terraform module for ingesting Heroku logs through a Lambda Function URL, forwarding processed logs to CloudWatch Logs, and archiving raw logs to S3 through Kinesis Firehose.

The Lambda source package lives in `support/lambda_heroku` and is packaged by `terraform-aws-modules/lambda/aws` from `package-lock.json`.
