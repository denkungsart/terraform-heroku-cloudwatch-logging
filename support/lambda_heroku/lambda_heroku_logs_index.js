'use strict';

import { FirehoseClient, PutRecordBatchCommand } from '@aws-sdk/client-firehose';
import {
  CloudWatchLogsClient,
  DescribeLogStreamsCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  buildCloudWatchLogEventBatches,
  buildCloudWatchLogEvents,
  buildFirehoseRecordBatches,
  buildLogStreamName,
  validateBasicAuth,
  validateRequiredEnv,
} from './lambda_heroku_logs_helpers.js';

// Initialize the AWS SDK clients (region is taken from process.env.AWS_REGION)
const firehoseClient = new FirehoseClient({ region: process.env.AWS_REGION });
const logsClient = new CloudWatchLogsClient({ region: process.env.AWS_REGION });
const FIREHOSE_MAX_FAILED_RECORD_RETRIES = 3;
const RETRYABLE_FIREHOSE_FAILURES = new Set(['InternalFailure', 'ServiceUnavailableException']);

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

  const events = buildCloudWatchLogEvents(logMessages);

  for (const batch of buildCloudWatchLogEventBatches(events)) {
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

function firehoseRetryDelay(attempt) {
  return 100 * (2 ** attempt);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function failedFirehoseRecords(response, records) {
  return (response.RequestResponses || [])
    .map((result, index) => ({ result, record: records[index] }))
    .filter(({ result }) => result.ErrorCode || result.ErrorMessage);
}

function summarizeFirehoseFailures(failures) {
  return failures.map(({ result }) => ({
    errorCode: result.ErrorCode,
    errorMessage: result.ErrorMessage,
  }));
}

async function putFirehoseBatchWithRetries(records) {
  let pendingRecords = records;

  for (let attempt = 0; attempt <= FIREHOSE_MAX_FAILED_RECORD_RETRIES; attempt += 1) {
    const firehoseCmd = new PutRecordBatchCommand({
      DeliveryStreamName: process.env.FIREHOSE_STREAM_NAME,
      Records: pendingRecords,
    });
    const response = await firehoseClient.send(firehoseCmd);

    if (!response.FailedPutCount) {
      return;
    }

    const failedRecords = failedFirehoseRecords(response, pendingRecords);
    if (failedRecords.length === 0) {
      console.error('Firehose reported failed records without per-record failure details', {
        failedPutCount: response.FailedPutCount,
        attempt: attempt + 1,
      });

      throw new Error(`Failed to deliver ${response.FailedPutCount} Heroku log record(s) to Firehose`);
    }

    const retryableRecords = failedRecords
      .filter(({ result }) => RETRYABLE_FIREHOSE_FAILURES.has(result.ErrorCode))
      .map(({ record }) => record);

    if (retryableRecords.length !== failedRecords.length || attempt === FIREHOSE_MAX_FAILED_RECORD_RETRIES) {
      console.error('Firehose rejected one or more log records', {
        failedPutCount: response.FailedPutCount,
        attempt: attempt + 1,
        failures: summarizeFirehoseFailures(failedRecords),
      });

      throw new Error(`Failed to deliver ${response.FailedPutCount} Heroku log record(s) to Firehose`);
    }

    pendingRecords = retryableRecords;
    await sleep(firehoseRetryDelay(attempt));
  }
}

async function sendLogsToFirehose(lines) {
  for (const records of buildFirehoseRecordBatches(lines)) {
    await putFirehoseBatchWithRetries(records);
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
        buildLogStreamName(process.env.HEROKU_LOGS_STREAM),
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
