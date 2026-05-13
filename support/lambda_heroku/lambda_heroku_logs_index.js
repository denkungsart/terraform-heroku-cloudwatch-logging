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
const defaultFirehoseClient = new FirehoseClient({ region: process.env.AWS_REGION });
const defaultLogsClient = new CloudWatchLogsClient({ region: process.env.AWS_REGION });
const FIREHOSE_MAX_FAILED_RECORD_RETRIES = 3;
const RETRYABLE_FIREHOSE_FAILURES = new Set(['InternalFailure', 'ServiceUnavailableException']);

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

export function createHandler({
  firehoseClient = defaultFirehoseClient,
  logsClient = defaultLogsClient,
  env = process.env,
  logger = console,
  now = () => new Date(),
  sleepFn = sleep,
  knownLogStreams = new Set(),
} = {}) {
  /**
   * Sends an array of processed log messages (plain text) to CloudWatch Logs.
   *
   * @param {string} logGroupName - The CloudWatch log group name.
   * @param {string} logStreamName - The CloudWatch log stream name.
   * @param {string[]} logMessages - Array of raw log messages.
   */
  async function ensureLogStream(logGroupName, logStreamName) {
    const cacheKey = `${logGroupName}:${logStreamName}`;

    if (knownLogStreams.has(cacheKey)) {
      return;
    }

    try {
      const describeResp = await logsClient.send(
        new DescribeLogStreamsCommand({
          logGroupName,
          logStreamNamePrefix: logStreamName,
        })
      );
      const stream = (describeResp.logStreams || []).find(ls => ls.logStreamName === logStreamName);

      if (stream) {
        knownLogStreams.add(cacheKey);
        return;
      }

      await logsClient.send(
        new CreateLogStreamCommand({ logGroupName, logStreamName })
      );
      knownLogStreams.add(cacheKey);
    } catch (error) {
      if (error.name === 'ResourceAlreadyExistsException') {
        knownLogStreams.add(cacheKey);
        return;
      }

      logger.error('Error describing/creating log stream:', error);
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
        logger.error('Error sending log events to CloudWatch Logs:', error);
        throw error;
      }
    }
  }

  async function putFirehoseBatchWithRetries(records) {
    let pendingRecords = records;

    for (let attempt = 0; attempt <= FIREHOSE_MAX_FAILED_RECORD_RETRIES; attempt += 1) {
      const firehoseCmd = new PutRecordBatchCommand({
        DeliveryStreamName: env.FIREHOSE_STREAM_NAME,
        Records: pendingRecords,
      });
      const response = await firehoseClient.send(firehoseCmd);

      if (!response.FailedPutCount) {
        return;
      }

      const failedRecords = failedFirehoseRecords(response, pendingRecords);
      if (failedRecords.length === 0) {
        logger.error('Firehose reported failed records without per-record failure details', {
          failedPutCount: response.FailedPutCount,
          attempt: attempt + 1,
        });

        throw new Error(`Failed to deliver ${response.FailedPutCount} Heroku log record(s) to Firehose`);
      }

      const retryableRecords = failedRecords
        .filter(({ result }) => RETRYABLE_FIREHOSE_FAILURES.has(result.ErrorCode))
        .map(({ record }) => record);

      if (retryableRecords.length !== failedRecords.length || attempt === FIREHOSE_MAX_FAILED_RECORD_RETRIES) {
        logger.error('Firehose rejected one or more log records', {
          failedPutCount: response.FailedPutCount,
          attempt: attempt + 1,
          failures: summarizeFirehoseFailures(failedRecords),
        });

        throw new Error(`Failed to deliver ${response.FailedPutCount} Heroku log record(s) to Firehose`);
      }

      pendingRecords = retryableRecords;
      await sleepFn(firehoseRetryDelay(attempt));
    }
  }

  async function sendLogsToFirehose(lines) {
    for (const records of buildFirehoseRecordBatches(lines)) {
      await putFirehoseBatchWithRetries(records);
    }
  }

  return async function handler(event) {
    try {
      validateRequiredEnv(env);

      // --- Basic Authentication ---
      const headers = event.headers || {};
      const authHeader = headers['Authorization'] || headers['authorization'];
      if (!validateBasicAuth(authHeader, env)) {
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
          env.HEROKU_LOGS_GROUP,   // e.g., "/heroku/logs"
          buildLogStreamName(env.HEROKU_LOGS_STREAM, now()),
          lines
        );
      }

      return {
        statusCode: 200,
        body: JSON.stringify({ status: "OK" }),
      };
    } catch (error) {
      logger.error('Error in Lambda:', error);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: error.message }),
      };
    }
  };
}

export const handler = createHandler();
