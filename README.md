# Heroku CloudWatch Logging Terraform Module

Terraform module for ingesting Heroku logs through a Lambda Function URL, forwarding processed logs to CloudWatch Logs, and archiving raw logs to S3 through Kinesis Firehose.

The Lambda source package lives in `support/lambda_heroku` and is packaged by `terraform-aws-modules/lambda/aws` from `package-lock.json`.

The handler acknowledges delivery only after its Firehose and CloudWatch writes complete. All handler responses have an empty body and `Content-Length: 0`, as required by [Heroku HTTPS drains](https://devcenter.heroku.com/articles/log-drains#https-drain-caveats). Authentication failures retain HTTP 401 and `WWW-Authenticate`; delivery failures retain HTTP 500, with diagnostics in Lambda logs. Verify the actual HTTP/1.1 response through the deployed Function URL after rollout, since AWS constructs the wire response.

Set `resource_namespace` for installations that share an AWS account. When unset, the module keeps the original un-namespaced resource names for backwards-compatible migrations.

The Rack::Attack status=429 alarm is present but notification actions are disabled by default. Set `enable_rack_attack_throttle_alert = true` to enable those notifications.

The Redis load average alert is opt-in. Set `enable_redis_load_avg_alert = true` to create it.

## Heroku Postgres metrics

The handler also publishes the `sample#` metrics Heroku Postgres writes to the app's log stream as CloudWatch metrics. It writes them as [embedded metric format](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html) events to a dedicated `/heroku/metrics` log group (namespaced like the other log groups), and CloudWatch extracts the metrics from there.

- Namespace: `Heroku/Postgres`, shared by all apps so dashboards can query them uniformly.
- Dimensions: `App` (`app_name`), `Database` (the attachment name, e.g. `DATABASE` or `HEROKU_POSTGRESQL_RED` for followers), and `Addon`.
- Metrics: `ReadIOPS`, `WriteIOPS`, `TableCacheHitRate`, `IndexCacheHitRate`, `MemoryCached`, `LoadAvg1m`, `ActiveConnections`, and `TmpDiskUsed`. The list lives in `POSTGRES_SAMPLE_METRICS` in the Lambda helpers.

Each metric is billed as one CloudWatch custom metric per database. Essential-tier databases do not log these samples, so they publish no metrics. Publishing is best effort: a failure is logged and never fails log delivery.

Set `grafana_workspace_role_arn` to an Amazon Managed Grafana workspace role to create a role that Grafana's CloudWatch data source can assume to read metrics in this account. The workspace role also needs permission to assume it. The role grants metrics access only, not access to the log contents.
