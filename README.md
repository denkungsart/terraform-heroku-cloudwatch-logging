# Heroku CloudWatch Logging Terraform Module

Terraform module for ingesting Heroku logs through a Lambda Function URL, forwarding processed logs to CloudWatch Logs, and archiving raw logs to S3 through Kinesis Firehose.

The Lambda source package lives in `support/lambda_heroku` and is packaged by `terraform-aws-modules/lambda/aws` from `package-lock.json`.

Set `resource_namespace` for installations that share an AWS account. When unset, the module keeps the original un-namespaced resource names for backwards-compatible migrations.

The Rack::Attack status=429 alarm is present but notification actions are disabled by default. Set `enable_rack_attack_throttle_alert = true` to enable those notifications.

The Redis load average alert is opt-in. Set `enable_redis_load_avg_alert = true` to create it.
