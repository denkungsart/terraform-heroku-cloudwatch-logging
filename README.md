# Heroku CloudWatch Logging Terraform Module

Terraform module for ingesting Heroku logs through a Lambda Function URL, forwarding processed logs to CloudWatch Logs, and archiving raw logs to S3 through Kinesis Firehose.

The Lambda source lives in `support/lambda_heroku`. Terraform zips the files listed in `package_sources.json` with the `archive_file` data source; npm dependencies are not packaged because the Node.js Lambda runtime provides the AWS SDK for JavaScript v3. The AWS SDK packages in `package.json` are development dependencies for the tests only, so the handler must not import anything besides `node:*` built-ins, `@aws-sdk/*` clients and its own files. After `npm ci` in `support/lambda_heroku`, `scripts/check-heroku-logs-lambda-package.sh` builds the same package, enforces that import rule and loads the packaged handler.

The handler acknowledges delivery only after its Firehose and CloudWatch writes complete. All handler responses have an empty body and `Content-Length: 0`, as required by [Heroku HTTPS drains](https://devcenter.heroku.com/articles/log-drains#https-drain-caveats). Authentication failures retain HTTP 401 and `WWW-Authenticate`; delivery failures retain HTTP 500, with diagnostics in Lambda logs. Verify the actual HTTP/1.1 response through the deployed Function URL after rollout, since AWS constructs the wire response.

Set `resource_namespace` for installations that share an AWS account. When unset, the module keeps the original un-namespaced resource names for backwards-compatible migrations.

The Rack::Attack status=429 alarm is present but notification actions are disabled by default. Set `enable_rack_attack_throttle_alert = true` to enable those notifications.

The Redis load average alert is opt-in. Set `enable_redis_load_avg_alert = true` to create it.

## Heroku metrics

The handler also publishes metrics extracted from the log stream. It writes them as [embedded metric format](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html) events to a dedicated `/heroku/metrics` log group (namespaced like the other log groups), and CloudWatch extracts the metrics from there. The namespaces are shared by all apps so dashboards can query them uniformly.

- `Heroku/Postgres`, from the `sample#` lines of Heroku Postgres, with dimensions `App` (`app_name`), `Database` (the attachment name, e.g. `DATABASE` or `HEROKU_POSTGRESQL_RED`) and `Addon`: `ReadIOPS`, `WriteIOPS`, `IopsUtilization`, `TableCacheHitRate`, `LoadAvg1m`, `WaitingConnections`, `ConnectionsUtilization`, and `DbSizeUtilization`. Utilization metrics are fractions of the plan limit. Essential-tier databases do not log these samples.
- `Heroku/Redis`, from the `sample#` lines of the Heroku Redis add-ons listed in `redis_metrics_addon_names`, with the same dimensions: `MemoryUsed`, `ConnectionsUtilization`, and `EvictedKeys`.
- `Heroku/Dyno`, from the [runtime metrics](https://devcenter.heroku.com/articles/log-runtime-metrics) lines, with dimensions `App` and `DynoType` (`web`, `worker`, …, but not one-off `run` and `release` dynos): `MemoryUtilization` (memory total over quota, above 1 means R14) and `LoadAvg1m`. Every dyno's value is kept, so Maximum shows the worst dyno of a type.
- `Heroku/Router`, from the router lines, with dimension `App`: `Requests`, `ServerErrors` (status 5xx), `RouterErrors` (H codes, except those the HerokuHTTPError alarm ignores), and `ServiceTime` with every request's service time, so percentiles work.

The lists live in `POSTGRES_SAMPLE_METRICS` and `REDIS_SAMPLE_METRICS` in the Lambda helpers. Each metric is billed as one CloudWatch custom metric per database, Redis add-on, dyno type or app. Publishing is best effort: a failure is logged and never fails log delivery.

Set `observability_sink_arns` to the CloudWatch cross-account observability sinks of the monitoring account, keyed by region, to link this account's metrics to the sink in the provider's region. The link shares metrics only, not the log contents. The sinks and the Grafana workspace that reads them live in [terraform-grafana](https://github.com/denkungsart/terraform-grafana).

The `HerokuMetricsMissing` alarm emails when no router metrics arrive for 30 minutes, which means the drain, the Lambda or metric publishing is broken. The Lambda logs its errors to `/aws/lambda/<function name>` (30 days retention).
