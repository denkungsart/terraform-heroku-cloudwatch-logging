'use strict';

import { FirehoseClient, PutRecordBatchCommand } from '@aws-sdk/client-firehose';
import {
  CloudWatchLogsClient,
  DescribeLogStreamsCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  buildLogStreamName,
  chunk,
  removePrefix,
  validateBasicAuth,
  validateRequiredEnv,
} from './lambda_heroku_logs_helpers.js';

// Initialize the AWS SDK clients (region is taken from process.env.AWS_REGION)
const firehoseClient = new FirehoseClient({ region: process.env.AWS_REGION });
const logsClient = new CloudWatchLogsClient({ region: process.env.AWS_REGION });
const CLOUDWATCH_LOGS_MAX_BATCH_SIZE = 10_000;

/**
 * Sends an array of processed log messages (plain text) to CloudWatch Logs.
 *
 * @param {string} logGroupName - The CloudWatch log group name.
 * @param {string} logStreamName - The CloudWatch log stream name.
 * @param {string[]} logMessages - Array of raw log messages.
 */
async function ensureLogStream(logGroupName, logStreamName) {
  try {
    const describeResp = await logsClient.send(
      new DescribeLogStreamsCommand({
        logGroupName,
        logStreamNamePrefix: logStreamName,
      })
    );
    const stream = describeResp.logStreams.find(ls => ls.logStreamName === logStreamName);

    if (stream) {
      return;
    }

    await logsClient.send(
      new CreateLogStreamCommand({ logGroupName, logStreamName })
    );
  } catch (error) {
    if (error.name === 'ResourceAlreadyExistsException') {
      return;
    }

    console.error('Error describing/creating log stream:', error);
    throw error;
  }
}

async function sendLogsToCloudWatch(logGroupName, logStreamName, logMessages) {
  await ensureLogStream(logGroupName, logStreamName);

  // Process each log message by removing the first two tokens.
  const events = logMessages.map((msg, index) => ({
    message: removePrefix(msg),
    timestamp: Date.now() + index,
  }));

  for (const batch of chunk(events, CLOUDWATCH_LOGS_MAX_BATCH_SIZE)) {
    try {
      await logsClient.send(new PutLogEventsCommand({
        logGroupName,
        logStreamName,
        logEvents: batch,
      }));
    } catch (error) {
      console.error('Error sending log events to CloudWatch Logs:', error);
      throw error;
    }
  }
}

async function sendLogsToFirehose(lines) {
  for (const batch of chunk(lines, 500)) {
    const firehoseCmd = new PutRecordBatchCommand({
      DeliveryStreamName: process.env.FIREHOSE_STREAM_NAME,
      Records: batch.map(line => ({ Data: line + '\n' })),
    });
    const response = await firehoseClient.send(firehoseCmd);

    if (!response.FailedPutCount) {
      continue;
    }

    const failedRecords = response.RequestResponses
      .map((result, index) => ({ result, line: batch[index] }))
      .filter(({ result }) => result.ErrorCode || result.ErrorMessage);

    console.error('Firehose rejected one or more log records', {
      failedPutCount: response.FailedPutCount,
      failures: failedRecords.map(({ result }) => ({
        errorCode: result.ErrorCode,
        errorMessage: result.ErrorMessage,
      })),
    });

    throw new Error(`Failed to deliver ${response.FailedPutCount} Heroku log record(s) to Firehose`);
  }
}

export const handler = async (event, context) => {
  try {
    validateRequiredEnv();

    // --- Basic Authentication ---
    const headers = event.headers || {};
    const authHeader = headers['Authorization'] || headers['authorization'];
    if (!validateBasicAuth(authHeader)) {
      return {
        statusCode: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Heroku Logs"' },
        body: JSON.stringify({ message: 'Unauthorized: Invalid credentials' }),
      };
    }

    // --- Base64 Decoding ---
    let body = event.body || '';
    if (event.isBase64Encoded) {
      body = Buffer.from(event.body, 'base64').toString('utf-8');
    }

    const lines = body.split('\n').filter(line => line.trim() !== '');

    if (lines.length > 0) {
      // --- Send raw logs to Firehose for S3 archival ---
      await sendLogsToFirehose(lines);

      // --- Send processed (prefix removed) logs to CloudWatch Logs ---
      await sendLogsToCloudWatch(
        process.env.HEROKU_LOGS_GROUP,   // e.g., "/heroku/logs"
        buildLogStreamName(process.env.HEROKU_LOGS_STREAM, context.awsRequestId),
        lines
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ status: "OK" }),
    };
  } catch (error) {
    console.error('Error in Lambda:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
