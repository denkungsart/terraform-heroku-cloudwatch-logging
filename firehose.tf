# CloudWatch log groups
# -------------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "firehose_diagnostics" {
  name              = local.firehose_diagnostics_log_group_name
  retention_in_days = 60
}

resource "aws_cloudwatch_log_group" "heroku_logs" {
  name              = local.heroku_logs_log_group_name
  retention_in_days = 60
}

# Kinesis Firehose delivery stream
# -------------------------------------------------------------------------------
resource "aws_kinesis_firehose_delivery_stream" "heroku_logs_stream" {
  name        = local.firehose_delivery_stream_name
  destination = "extended_s3"

  extended_s3_configuration {
    role_arn            = aws_iam_role.firehose_role.arn
    bucket_arn          = var.log_bucket_arn
    prefix              = local.firehose_s3_prefix       # S3 key prefix
    error_output_prefix = local.firehose_s3_error_prefix # S3 error prefix

    buffering_size     = 5  # MB
    buffering_interval = 60 # seconds

    compression_format = "GZIP"

    cloudwatch_logging_options {
      enabled         = true
      log_group_name  = aws_cloudwatch_log_group.firehose_diagnostics.name
      log_stream_name = local.firehose_log_stream_name
    }
  }
}
