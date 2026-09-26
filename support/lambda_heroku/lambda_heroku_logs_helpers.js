'use strict';

import { timingSafeEqual } from 'node:crypto';

const REQUIRED_ENV_VARS = [
  'APP_NAME',
  'AUTH_USERNAME',
  'AUTH_PASSWORD',
  'FIREHOSE_STREAM_NAME',
  'HEROKU_LOGS_GROUP',
  'HEROKU_LOGS_STREAM',
  'HEROKU_METRICS_GROUP',
  'HEROKU_METRICS_STREAM',
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
export const POSTGRES_METRICS_NAMESPACE = 'Heroku/Postgres';
export const POSTGRES_METRICS_DIMENSIONS = ['App', 'Database', 'Addon'];

// Heroku Postgres samples published as CloudWatch metrics, keyed by the name
// after `sample#`. Each entry is billed as one custom metric per database.
export const POSTGRES_SAMPLE_METRICS = {
  'read-iops': { name: 'ReadIOPS', unit: 'Count/Second' },
  'write-iops': { name: 'WriteIOPS', unit: 'Count/Second' },
  'table-cache-hit-rate': { name: 'TableCacheHitRate', unit: 'None' },
  'index-cache-hit-rate': { name: 'IndexCacheHitRate', unit: 'None' },
  'memory-cached': { name: 'MemoryCached', unit: 'Kilobytes' },
  'load-avg-1m': { name: 'LoadAvg1m', unit: 'None' },
  'active-connections': { name: 'ActiveConnections', unit: 'Count' },
  'tmp-disk-used': { name: 'TmpDiskUsed', unit: 'Bytes' },
};

// Frame length, priority/version, timestamp, host, app, proc, msgid, message.
const HEROKU_SYSLOG_LINE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+(.*)$/;

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

export function stripAnsiEscapeCodes(message) {
  return message.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
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
      message: stripAnsiEscapeCodes(removePrefix(line)),
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

function parseLogfmtFields(message) {
  const fields = {};

  for (const token of message.split(/\s+/)) {
    const separatorIndex = token.indexOf('=');

    if (separatorIndex > 0) {
      fields[token.slice(0, separatorIndex)] = token.slice(separatorIndex + 1);
    }
  }

  return fields;
}

/**
 * Extracts the published metrics from a Heroku Postgres `sample#` log line.
 * Returns null for any other line.
 */
export function parsePostgresSample(line, fallbackTimestamp) {
  const match = line.match(HEROKU_SYSLOG_LINE);

  if (!match || match[1] !== 'heroku-postgres') {
    return null;
  }

  const fields = parseLogfmtFields(match[2]);

  if (!fields.source || !fields.addon) {
    return null;
  }

  const values = {};

  for (const [sample, metric] of Object.entries(POSTGRES_SAMPLE_METRICS)) {
    // parseFloat drops unit suffixes such as `kB` on memory samples.
    const value = Number.parseFloat(fields[`sample#${sample}`]);

    if (Number.isFinite(value)) {
      values[metric.name] = value;
    }
  }

  if (Object.keys(values).length === 0) {
    return null;
  }

  return {
    timestamp: parseHerokuLogTimestamp(line, fallbackTimestamp),
    database: fields.source,
    addon: fields.addon,
    values,
  };
}

/**
 * Builds CloudWatch embedded metric format (EMF) log events for the Heroku
 * Postgres samples in the given raw log lines.
 */
export function buildPostgresMetricEvents(lines, appName, fallbackTimestamp = Date.now()) {
  return lines
    .map(line => parsePostgresSample(line, fallbackTimestamp))
    .filter(sample => sample !== null)
    .map(sample => ({
      timestamp: sample.timestamp,
      message: JSON.stringify({
        _aws: {
          Timestamp: sample.timestamp,
          CloudWatchMetrics: [{
            Namespace: POSTGRES_METRICS_NAMESPACE,
            Dimensions: [POSTGRES_METRICS_DIMENSIONS],
            Metrics: Object.values(POSTGRES_SAMPLE_METRICS)
              .filter(metric => metric.name in sample.values)
              .map(metric => ({ Name: metric.name, Unit: metric.unit })),
          }],
        },
        App: appName,
        Database: sample.database,
        Addon: sample.addon,
        ...sample.values,
      }),
    }))
    .sort((first, second) => first.timestamp - second.timestamp);
}

/**
 * Smithy build-step middleware that marks a PutLogEvents request as EMF, which
 * CloudWatch requires before it extracts metrics from events sent via the API.
 */
export function emfFormatHeaderMiddleware(next) {
  return args => {
    args.request.headers['x-amzn-logs-format'] = 'json/emf';
    return next(args);
  };
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
