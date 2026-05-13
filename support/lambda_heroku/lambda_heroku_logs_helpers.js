'use strict';

import { timingSafeEqual } from 'node:crypto';

const REQUIRED_ENV_VARS = [
  'AUTH_USERNAME',
  'AUTH_PASSWORD',
  'FIREHOSE_STREAM_NAME',
  'HEROKU_LOGS_GROUP',
  'HEROKU_LOGS_STREAM',
];
export const FIREHOSE_MAX_BATCH_BYTES = 4 * 1024 * 1024;
export const FIREHOSE_MAX_RECORD_BYTES = 1_024_000;
export const FIREHOSE_MAX_RECORDS_PER_BATCH = 500;
export const CLOUDWATCH_LOGS_EVENT_OVERHEAD_BYTES = 26;
export const CLOUDWATCH_LOGS_MAX_BATCH_BYTES = 1_048_576;
export const CLOUDWATCH_LOGS_MAX_BATCH_SPAN_MS = 24 * 60 * 60 * 1000;
export const CLOUDWATCH_LOGS_MAX_EVENT_MESSAGE_BYTES =
  CLOUDWATCH_LOGS_MAX_BATCH_BYTES - CLOUDWATCH_LOGS_EVENT_OVERHEAD_BYTES;
export const CLOUDWATCH_LOGS_MAX_EVENTS_PER_BATCH = 10_000;

export function chunk(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

export function buildLogStreamName(baseName, date = new Date()) {
  const day = date.toISOString().slice(0, 10);

  if (!baseName) {
    return day;
  }

  return `${baseName}/${day}`;
}

/**
 * Removes the initial formation and syslog header tokens from a log line.
 */
export function removePrefix(line) {
  return line.replace(/^\S+\s+\S+\s+/, '');
}

export function buildFirehoseRecordBatches(lines) {
  const batches = [];
  let currentBatch = [];
  let currentBatchBytes = 0;

  for (const line of lines) {
    const data = `${line}\n`;
    const byteLength = Buffer.byteLength(data, 'utf8');

    if (byteLength > FIREHOSE_MAX_RECORD_BYTES) {
      throw new Error(`Heroku log line exceeds Firehose record limit of ${FIREHOSE_MAX_RECORD_BYTES} bytes`);
    }

    if (
      currentBatch.length >= FIREHOSE_MAX_RECORDS_PER_BATCH ||
      currentBatchBytes + byteLength > FIREHOSE_MAX_BATCH_BYTES
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBatchBytes = 0;
    }

    currentBatch.push({ Data: data });
    currentBatchBytes += byteLength;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

export function parseHerokuLogTimestamp(line, fallbackTimestamp) {
  const match = line.match(/^\S+\s+\S+\s+(\S+)/);

  if (!match) {
    return fallbackTimestamp;
  }

  const timestamp = Date.parse(match[1]);

  if (!Number.isFinite(timestamp)) {
    return fallbackTimestamp;
  }

  return timestamp;
}

export function buildCloudWatchLogEvents(lines, fallbackTimestamp = Date.now()) {
  return lines
    .map(line => ({
      message: removePrefix(line),
      timestamp: parseHerokuLogTimestamp(line, fallbackTimestamp),
    }))
    .sort((first, second) => first.timestamp - second.timestamp);
}

function cloudWatchLogEventSize(event) {
  return Buffer.byteLength(event.message, 'utf8') + CLOUDWATCH_LOGS_EVENT_OVERHEAD_BYTES;
}

export function buildCloudWatchLogEventBatches(events) {
  const batches = [];
  let currentBatch = [];
  let currentBatchBytes = 0;
  let currentBatchStartTimestamp = null;

  for (const event of events) {
    const messageBytes = Buffer.byteLength(event.message, 'utf8');
    const eventBytes = messageBytes + CLOUDWATCH_LOGS_EVENT_OVERHEAD_BYTES;

    if (messageBytes > CLOUDWATCH_LOGS_MAX_EVENT_MESSAGE_BYTES) {
      throw new Error(
        `CloudWatch log event exceeds message limit of ${CLOUDWATCH_LOGS_MAX_EVENT_MESSAGE_BYTES} bytes`
      );
    }

    if (
      currentBatch.length > 0 &&
      (
        currentBatch.length >= CLOUDWATCH_LOGS_MAX_EVENTS_PER_BATCH ||
        currentBatchBytes + eventBytes > CLOUDWATCH_LOGS_MAX_BATCH_BYTES ||
        event.timestamp - currentBatchStartTimestamp > CLOUDWATCH_LOGS_MAX_BATCH_SPAN_MS
      )
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBatchBytes = 0;
      currentBatchStartTimestamp = null;
    }

    if (currentBatchStartTimestamp === null) {
      currentBatchStartTimestamp = event.timestamp;
    }

    currentBatch.push(event);
    currentBatchBytes += cloudWatchLogEventSize(event);
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function safeEqualString(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') {
    return false;
  }

  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function parseBasicAuth(authHeader) {
  if (typeof authHeader !== 'string' || !authHeader.match(/^Basic\s+/i)) {
    return null;
  }

  let credentials;
  try {
    credentials = Buffer.from(authHeader.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
  } catch {
    return null;
  }

  const separatorIndex = credentials.indexOf(':');
  if (separatorIndex === -1) {
    return null;
  }

  return {
    username: credentials.slice(0, separatorIndex),
    password: credentials.slice(separatorIndex + 1),
  };
}

/**
 * Validates Basic Authentication credentials.
 */
export function validateBasicAuth(authHeader, env = process.env) {
  const credentials = parseBasicAuth(authHeader);

  if (!credentials) {
    return false;
  }

  return (
    safeEqualString(credentials.username, env.AUTH_USERNAME) &&
    safeEqualString(credentials.password, env.AUTH_PASSWORD)
  );
}

export function validateRequiredEnv(env = process.env) {
  const missing = REQUIRED_ENV_VARS.filter(name => !env[name]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }
}
