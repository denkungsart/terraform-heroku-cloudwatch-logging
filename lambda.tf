resource "random_string" "heroku_logs_lambda_basic_auth_username" {
  length  = 32
  special = false
}

resource "random_string" "heroku_logs_lambda_basic_auth_password" {
  length  = 32
  special = false
}

# Lambda function code package
# -------------------------------------------------------------------------------
locals {
  lambda_package_sources = jsondecode(file("${local.lambda_source_path}/package_sources.json"))
}

# Package only the handler files listed in package_sources.json. The Node.js Lambda
# runtime provides the AWS SDK for JavaScript v3, so no npm dependencies are installed
# and no packaging code runs locally during plan or apply.
data "archive_file" "heroku_logs_lambda" {
  type        = "zip"
  output_path = "${path.root}/builds/${local.lambda_function_name}.zip"

  dynamic "source" {
    for_each = [for claim in local.lambda_package_sources : claim if can(claim.path)]
    content {
      content  = file("${local.lambda_source_path}/${source.value.path}")
      filename = source.value.path
    }
  }

  lifecycle {
    precondition {
      condition     = alltrue([for claim in local.lambda_package_sources : can(claim.path) && length(claim) == 1])
      error_message = "package_sources.json may only list files as {\"path\": ...}; npm dependencies are not packaged because the Node.js Lambda runtime provides the AWS SDK."
    }
  }
}

# Lambda function for heroku logs
# -------------------------------------------------------------------------------
module "heroku_logs_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = local.lambda_function_name
  description   = "Lambda function for ingesting Heroku logs, forwarding raw logs to Firehose for S3 archival and to CloudWatch Logs for real-time analysis"
  handler       = "lambda_heroku_logs_index.handler"
  runtime       = "nodejs22.x"

  create_package         = false
  local_existing_package = data.archive_file.heroku_logs_lambda.output_path

  environment_variables = {
    APP_NAME              = var.app_name
    FIREHOSE_STREAM_NAME  = aws_kinesis_firehose_delivery_stream.heroku_logs_stream.name
    HEROKU_LOGS_GROUP     = aws_cloudwatch_log_group.heroku_logs.name
    HEROKU_LOGS_STREAM    = local.heroku_logs_log_stream_name
    HEROKU_METRICS_GROUP  = aws_cloudwatch_log_group.heroku_metrics.name
    HEROKU_METRICS_STREAM = local.heroku_metrics_log_stream_name
    AUTH_USERNAME         = random_string.heroku_logs_lambda_basic_auth_username.result # Note: Acceptable security trade-off to store this as cleartext
    AUTH_PASSWORD         = random_string.heroku_logs_lambda_basic_auth_password.result # Note: Acceptable security trade-off to store this as cleartext
  }

  memory_size   = 128
  timeout       = 10
  architectures = ["arm64"]

  # Heroku drains cannot sign AWS_IAM requests, so the public Function URL uses
  # NONE here and the handler enforces Basic Auth from the drain URL credentials.
  create_lambda_function_url = true
  authorization_type         = "NONE"

  attach_cloudwatch_logs_policy = false # custom policy attached below
  attach_policy_json            = false
  attach_policy_statements      = true
  policy_statements = {
    heroku_logs_firehose = {
      actions = [
        "firehose:PutRecord",
        "firehose:PutRecordBatch"
      ]
      resources = [
        aws_kinesis_firehose_delivery_stream.heroku_logs_stream.arn
      ]
    },
    heroku_logs_cloudwatch = {
      actions = [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams"
      ]
      resources = [
        aws_cloudwatch_log_group.heroku_logs.arn,
        "${aws_cloudwatch_log_group.heroku_logs.arn}:*",
        aws_cloudwatch_log_group.heroku_metrics.arn,
        "${aws_cloudwatch_log_group.heroku_metrics.arn}:*"
      ]
    }
  }
}

# Heroku drain configuration
# -------------------------------------------------------------------------------
resource "heroku_drain" "app_log_drain" {
  app_id = var.heroku_app_id

  url = "https://${random_string.heroku_logs_lambda_basic_auth_username.result}:${random_string.heroku_logs_lambda_basic_auth_password.result}@${trim(replace(module.heroku_logs_lambda.lambda_function_url, "https://", ""), "/")}"
}
