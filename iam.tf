# IAM role for Kinesis Firehose
# -------------------------------------------------------------------------------
resource "aws_iam_role" "firehose_role" {
  name               = local.firehose_role_name
  assume_role_policy = data.aws_iam_policy_document.firehose_assume_role.json
}

data "aws_iam_policy_document" "firehose_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["firehose.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "firehose_policy" {
  statement {
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:AbortMultipartUpload",
      "s3:ListBucket",
      "s3:GetBucketLocation"
    ]
    resources = [
      var.log_bucket_arn,
      "${var.log_bucket_arn}/*"
    ]
  }
  statement {
    effect = "Allow"
    actions = [
      "logs:PutLogEvents",
      "logs:CreateLogStream",
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams"
    ]
    resources = [
      aws_cloudwatch_log_group.firehose_diagnostics.arn,
      "${aws_cloudwatch_log_group.firehose_diagnostics.arn}:*"
    ]
  }
}

resource "aws_iam_role_policy" "firehose_role_policy" {
  role   = aws_iam_role.firehose_role.id
  policy = data.aws_iam_policy_document.firehose_policy.json
}
