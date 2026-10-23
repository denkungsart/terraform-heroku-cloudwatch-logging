# Heroku CloudWatch Logging Terraform Module

Terraform module for ingesting Heroku logs through a Lambda Function URL, forwarding processed logs to CloudWatch Logs, and archiving raw logs to S3 through Kinesis Firehose.

The Lambda source lives in `support/lambda_heroku`. Terraform zips the files listed in `package_sources.json` with the `archive_file` data source; npm dependencies are not packaged because the Node.js Lambda runtime provides the AWS SDK for JavaScript v3. The AWS SDK packages in `package.json` are development dependencies for the tests only, so the handler must not import anything besides `node:*` built-ins, `@aws-sdk/*` clients and its own files. After `npm ci` in `support/lambda_heroku`, `scripts/check-heroku-logs-lambda-package.sh` builds the same package, enforces that import rule and loads the packaged handler.

The handler acknowledges delivery only after its Firehose and CloudWatch writes complete. All handler responses have an empty body and `Content-Length: 0`, as required by [Heroku HTTPS drains](https://devcenter.heroku.com/articles/log-drains#https-drain-caveats). Authentication failures retain HTTP 401 and `WWW-Authenticate`; delivery failures retain HTTP 500, with diagnostics in Lambda logs. Verify the actual HTTP/1.1 response through the deployed Function URL after rollout, since AWS constructs the wire response.

Firehose bills every record as at least 5 KB, so the handler packs the lines of a drain request into as few records as possible. Each line keeps its newline, so the archived objects are the same as with one record per line. Firehose writes an S3 object every 15 minutes or 64 MB, whichever comes first; lifecycle rules for the archive belong to the bucket passed as `log_bucket_arn`.

`heroku_logs_retention_in_days` (default 60) sets how long CloudWatch Logs keeps the processed logs; the S3 archive is independent of it. The Function URL is public, so `lambda_reserved_concurrent_executions` can cap what a flood of unauthenticated requests costs; set it well above the function's peak `ConcurrentExecutions`, because throttled drain requests lose logs.

Set `resource_namespace` for installations that share an AWS account. When unset, the module keeps the original un-namespaced resource names for backwards-compatible migrations.

`enable_redis_load_avg_alert`, `app_fqdn`, `enable_rack_attack_throttle_alert`, `log_metrics_without_alarm` and `heroku_app_name` are deprecated and ignored.

## Heroku metrics

The handler also publishes metrics extracted from the log stream. It writes them as [embedded metric format](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html) events to a dedicated `/heroku/metrics` log group (namespaced like the other log groups), and CloudWatch extracts the metrics from there. The namespaces are shared by all apps so dashboards can query them uniformly. Their `App` dimension is `metrics_app_name`, which defaults to `app_name` and also names the `Heroku/<metrics_app_name>/...` namespaces of the log metric filters; set it to show an app under another name in Grafana without renaming its resources. Data published under the old name stays there.

- `Heroku/Postgres`, from the `sample#` lines of Heroku Postgres, with dimensions `App`, `Database` (the attachment name, e.g. `DATABASE` or `HEROKU_POSTGRESQL_RED`) and `Addon`: `ReadIOPS`, `WriteIOPS`, `IopsUtilization`, `TableCacheHitRate`, `LoadAvg1m`, `ConnectionsUtilization`, and `DbSizeUtilization`. Utilization metrics are fractions of the plan limit. Essential-tier databases do not log these samples.
- `Heroku/Redis`, from the `sample#` lines of the Heroku Redis add-ons listed in `redis_metrics_addon_names`, with the same dimensions: `MemoryUsed` and `ConnectionsUtilization`.
- `Heroku/Dyno`, from the [runtime metrics](https://devcenter.heroku.com/articles/log-runtime-metrics) lines, with dimensions `App` and `DynoType` (`web`, `worker`, …, but not one-off `run`, `release` and Heroku Scheduler dynos): `MemoryUtilization` (memory total over quota, above 1 means R14). Every dyno's value is kept, so Maximum shows the worst dyno of a type.
- `Heroku/App`, with dimension `App`: `Releases`, one per `Release vN created by …` line, so dashboards can mark deploys.
- `Heroku/Router`, from the router lines, with dimension `App`: `Requests`, `ServerErrors` (status 5xx, except the 503s of maintenance mode, H80), and `ServiceTime` with every request's service time, so percentiles work. Router errors (H codes) are counted by the `HerokuHTTPError` log metric filter instead. A drain request often carries a single router line, so each warm Lambda container collects router requests for up to a minute and then publishes one event per minute of request time; the requests a container holds when Lambda shuts it down are lost.

The lists live in `POSTGRES_SAMPLE_METRICS` and `REDIS_SAMPLE_METRICS` in the Lambda helpers. Each metric is billed as one CloudWatch custom metric per database, Redis add-on, dyno type or app. Publishing is best effort: a failure is logged and never fails log delivery. Metric ingestion is billed per byte of these events, which is why router lines are collected before publishing.

Set `observability_sink_arns` to the CloudWatch cross-account observability sinks of the monitoring account, keyed by region, to link this account's metrics to the sink in the provider's region. The link shares metrics only, not the log contents. The sinks and the Grafana workspace that reads them are managed separately, in the monitoring account.

The `HerokuMetricsMissing` alarm emails when no router metrics arrive for 30 minutes, which means the drain, the Lambda or metric publishing is broken. The Lambda logs its errors to `/aws/lambda/<function name>` (30 days retention).

## Linking other regions

AWS publishes some metrics only in `us-east-1`, such as Route53 health checks and CloudFront. The `modules/observability-link` submodule links an account's metrics in another region to a sink there:

```hcl
module "observability_link_us_east_1" {
  source    = "git::https://github.com/denkungsart/terraform-heroku-cloudwatch-logging.git//modules/observability-link?ref=main"
  providers = { aws = aws.us-east-1 }

  sink_arn = data.terraform_remote_state.grafana.outputs.observability_sink_arns["us-east-1"]
}
```

## Alerts

The log metric filters (Redis errors and memory limit, Heroku H and R errors, Logplex L10, Sidekiq poison pills, Rack::Attack throttling, API 401s, Sentry client errors and the PostgreSQL type map race condition) only feed metrics, so this module creates no CloudWatch alarm for them. Grafana alert rules in the monitoring account alert on most of them and on the apps' Sidekiq queue latency. `RackAttackThrottle` and `HerokuHTTPError` only feed dashboards: router H errors answer with status 503, so the Grafana "5xx responses" rule on `ServerErrors` covers them.

The only alarm left here is `HerokuMetricsMissing`, which emails `alert_email`. `pagerduty_aws_cloudwatch_integration_key` is deprecated and ignored.
