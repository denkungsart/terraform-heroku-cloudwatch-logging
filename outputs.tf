output "heroku_logs_log_group_name" {
  description = "CloudWatch Logs group receiving processed Heroku logs."
  value       = aws_cloudwatch_log_group.heroku_logs.name
}

output "firehose_delivery_stream_name" {
  description = "Kinesis Firehose delivery stream archiving raw Heroku logs to S3."
  value       = aws_kinesis_firehose_delivery_stream.heroku_logs_stream.name
}

output "lambda_function_url" {
  description = "Lambda Function URL used by the Heroku HTTPS log drain."
  value       = module.heroku_logs_lambda.lambda_function_url
  sensitive   = true
}
