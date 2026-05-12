'use strict';

import { FirehoseClient, PutRecordBatchCommand } from '@aws-sdk/client-firehose';
import {
  CloudWatchLogsClient,
  DescribeLogStreamsCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';

// Initialize the AWS SDK clients (region is taken from process.env.AWS_REGION)
const firehoseClient = new FirehoseClient({ region: process.env.AWS_REGION });
const logsClient = new CloudWatchLogsClient({ region: process.env.AWS_REGION });
const CLOUDWATCH_LOGS_MAX_BATCH_SIZE = 10_000;

function chunk(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function buildLogStreamName(baseName, requestId) {
  if (!baseName) {
    return requestId;
  }

  return `${baseName}/${requestId}`;
}

/**
 * Removes the initial formation and syslog header tokens from a log line.
 *
 * For example, for a log line:
 *
 *    "328 <134>1 2025-01-12T20:26:22.585603+00:00 host heroku router - at=info ..."
 *
 * This function will remove the first two tokens ("328" and "<134>1") and return:
 *
 *    "2025-01-12T20:26:22.585603+00:00 host heroku router - at=info ..."
 *
 * @param {string} line - A single log line.
 * @returns {string} - The log line with the prefix removed.
 */
function removePrefix(line) {
  const tokens = line.split(/\s+/);
  // If there are two or fewer tokens, return as is.
  if (tokens.length <= 2) {
    return line;
  }
  // Return the log line starting from the third token.
  return tokens.slice(2).join(' ');
}

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

/**
 * Validates Basic Authentication credentials.
 *
 * @param {string} authHeader - The value of the Authorization header.
 * @returns {boolean} - Returns true if authentication is successful, false otherwise.
 */
function validateBasicAuth(authHeader) {
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return false;
  }

  // Decode the Base64-encoded credentials
  const base64Credentials = authHeader.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
  const [username, password] = credentials.split(':');

  // Retrieve expected credentials from environment variables
  const expectedUsername = process.env.AUTH_USERNAME;
  const expectedPassword = process.env.AUTH_PASSWORD;

  // Compare provided credentials with expected credentials
  return username === expectedUsername && password === expectedPassword;
}

export const handler = async (event, context) => {
  try {
    // --- Basic Authentication ---
    const authHeader = event.headers['Authorization'] || event.headers['authorization'];
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
