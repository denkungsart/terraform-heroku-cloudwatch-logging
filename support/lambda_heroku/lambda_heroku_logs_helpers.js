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
export const ADDON_METRICS_DIMENSIONS = ['App', 'Database', 'Addon'];
export const ROUTER_METRICS_NAMESPACE = 'Heroku/Router';
export const ROUTER_METRICS_DIMENSIONS = ['App'];
export const DYNO_METRICS_NAMESPACE = 'Heroku/Dyno';
export const EMF_MAX_VALUES_PER_METRIC = 100;

// Heroku Postgres samples published as CloudWatch metrics, keyed by the name
// after `sample#`. Each entry is billed as one custom metric per database.
// Utilization metrics are fractions from 0 to 1 of the plan limit.
export const POSTGRES_SAMPLE_METRICS = {
  'read-iops': { name: 'ReadIOPS', unit: 'Count/Second' },
  'write-iops': { name: 'WriteIOPS', unit: 'Count/Second' },
  'iops-percentage-used': { name: 'IopsUtilization', unit: 'None' },
  'table-cache-hit-rate': { name: 'TableCacheHitRate', unit: 'None' },
  'index-cache-hit-rate': { name: 'IndexCacheHitRate', unit: 'None' },
  'memory-cached': { name: 'MemoryCached', unit: 'Kilobytes' },
  'memory-percentage-used': { name: 'MemoryUtilization', unit: 'None' },
  'load-avg-1m': { name: 'LoadAvg1m', unit: 'None' },
  'active-connections': { name: 'ActiveConnections', unit: 'Count' },
  'waiting-connections': { name: 'WaitingConnections', unit: 'Count' },
  'connections-percentage-used': { name: 'ConnectionsUtilization', unit: 'None' },
  'db-size-percentage-used': { name: 'DbSizeUtilization', unit: 'None' },
  'tmp-disk-used': { name: 'TmpDiskUsed', unit: 'Bytes' },
};

// Heroku Redis samples, published only for allowlisted add-ons. Memory and
// load samples describe the shared host, so memory-redis is the add-on usage.
export const REDIS_SAMPLE_METRICS = {
  'memory-redis': { name: 'MemoryUsed', unit: 'Bytes' },
  'active-connections': { name: 'ActiveConnections', unit: 'Count' },
  'connection-percentage-used': { name: 'ConnectionsUtilization', unit: 'None' },
  'hit-rate': { name: 'HitRate', unit: 'None' },
  'evicted-keys': { name: 'EvictedKeys', unit: 'Count' },
};

// Add-on sample metrics by the syslog process name of their log lines.
export const ADDON_SAMPLE_SOURCES = {
  'heroku-postgres': { namespace: 'Heroku/Postgres', metrics: POSTGRES_SAMPLE_METRICS },
  'heroku-redis': { namespace: 'Heroku/Redis', metrics: REDIS_SAMPLE_METRICS },
};

// Router error codes caused by clients, maintenance mode or the platform, as
// excluded by the HerokuHTTPError alarm.
const IGNORED_ROUTER_ERROR_CODES = new Set(['H27', 'H28', 'H31', 'H32', 'H80', 'H99']);

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

function parseHerokuSyslogLine(line) {
  const match = line.match(HEROKU_SYSLOG_LINE);

  return match ? { proc: match[1], fields: parseLogfmtFields(match[2]) } : null;
}

/**
 * Extracts the published metrics from a Heroku Postgres or Heroku Redis
 * `sample#` log line. Returns null for any other line.
 */
export function parseAddonSample(line, fallbackTimestamp) {
  const parsed = parseHerokuSyslogLine(line);
  const source = parsed && ADDON_SAMPLE_SOURCES[parsed.proc];

  if (!source || !parsed.fields.source || !parsed.fields.addon) {
    return null;
  }

  const values = {};

  for (const [sample, metric] of Object.entries(source.metrics)) {
    // parseFloat drops unit suffixes such as `kB` on memory samples.
    const value = Number.parseFloat(parsed.fields[`sample#${sample}`]);

    if (Number.isFinite(value)) {
      values[metric.name] = value;
    }
  }

  if (Object.keys(values).length === 0) {
    return null;
  }

  return {
    proc: parsed.proc,
    timestamp: parseHerokuLogTimestamp(line, fallbackTimestamp),
    database: parsed.fields.source,
    addon: parsed.fields.addon,
    values,
  };
}

/**
 * Extracts the status, service time and error state from a Heroku router log
 * line. Returns null for any other line.
 */
export function parseRouterLine(line, fallbackTimestamp) {
  const parsed = parseHerokuSyslogLine(line);

  if (!parsed || parsed.proc !== 'router') {
    return null;
  }

  const status = Number.parseInt(parsed.fields.status, 10);
  const serviceMs = Number.parseFloat(parsed.fields.service);

  if (!Number.isFinite(status)) {
    return null;
  }

  return {
    timestamp: parseHerokuLogTimestamp(line, fallbackTimestamp),
    status,
    serviceMs: Number.isFinite(serviceMs) ? serviceMs : null,
    error: parsed.fields.at === 'error' && !IGNORED_ROUTER_ERROR_CODES.has(parsed.fields.code),
  };
}

/**
 * Extracts memory utilization and load from a Heroku dyno runtime metrics
 * (log-runtime-metrics) line. Returns null for any other line.
 */
export function parseDynoSample(line, fallbackTimestamp) {
  const parsed = parseHerokuSyslogLine(line);

  if (!parsed || !parsed.fields.source || !parsed.fields.dyno?.startsWith('heroku.')) {
    return null;
  }

  // parseFloat drops the MB suffix of memory samples.
  const memoryTotal = Number.parseFloat(parsed.fields['sample#memory_total']);
  const memoryQuota = Number.parseFloat(parsed.fields['sample#memory_quota']);
  const loadAvg1m = Number.parseFloat(parsed.fields['sample#load_avg_1m']);
  const values = {};

  if (Number.isFinite(memoryTotal) && memoryQuota > 0) {
    values.MemoryUtilization = memoryTotal / memoryQuota;
  }

  if (Number.isFinite(loadAvg1m)) {
    values.LoadAvg1m = loadAvg1m;
  }

  if (Object.keys(values).length === 0) {
    return null;
  }

  return {
    timestamp: parseHerokuLogTimestamp(line, fallbackTimestamp),
    // web.1 -> web, worker.2 -> worker, run.1234 -> run
    dynoType: parsed.fields.source.split('.')[0],
    values,
  };
}

function emfEvent(timestamp, namespace, dimensions, metrics) {
  return {
    timestamp,
    message: JSON.stringify({
      _aws: {
        Timestamp: timestamp,
        CloudWatchMetrics: [{
          Namespace: namespace,
          Dimensions: [Object.keys(dimensions)],
          Metrics: metrics.map(metric => ({ Name: metric.name, Unit: metric.unit })),
        }],
      },
      ...dimensions,
      ...Object.fromEntries(metrics.map(metric => [metric.name, metric.value])),
    }),
  };
}

function addonSampleEvent(sample, appName) {
  const metrics = Object.values(ADDON_SAMPLE_SOURCES[sample.proc].metrics)
    .filter(metric => metric.name in sample.values)
    .map(metric => ({ ...metric, value: sample.values[metric.name] }));

  return emfEvent(
    sample.timestamp,
    ADDON_SAMPLE_SOURCES[sample.proc].namespace,
    { App: appName, Database: sample.database, Addon: sample.addon },
    metrics
  );
}

// One drain request carries many router lines, so the router metrics of a
// request go into one event. EMF allows 100 values per metric, so service
// times beyond that go into further events.
function routerEvents(requests, appName) {
  if (requests.length === 0) {
    return [];
  }

  const timestamp = Math.max(...requests.map(request => request.timestamp));
  const serviceTimes = requests.map(request => request.serviceMs).filter(value => value !== null);
  const serviceTimeChunks = serviceTimes.length > 0 ? chunk(serviceTimes, EMF_MAX_VALUES_PER_METRIC) : [[]];

  return serviceTimeChunks.map((values, index) => {
    const metrics = [];

    if (index === 0) {
      metrics.push(
        { name: 'Requests', unit: 'Count', value: requests.length },
        { name: 'ServerErrors', unit: 'Count', value: requests.filter(request => request.status >= 500).length },
        { name: 'RouterErrors', unit: 'Count', value: requests.filter(request => request.error).length }
      );
    }

    if (values.length > 0) {
      metrics.push({ name: 'ServiceTime', unit: 'Milliseconds', value: values });
    }

    return emfEvent(timestamp, ROUTER_METRICS_NAMESPACE, { App: appName }, metrics);
  });
}

// Dyno samples are published per dyno type rather than per dyno, so the
// metric count does not grow with the formation. Maximum then shows the worst
// dyno of a type.
function dynoEvents(samples, appName) {
  const byType = new Map();

  for (const sample of samples) {
    const group = byType.get(sample.dynoType) ?? { timestamp: 0, MemoryUtilization: [], LoadAvg1m: [] };

    group.timestamp = Math.max(group.timestamp, sample.timestamp);
    for (const [name, value] of Object.entries(sample.values)) {
      group[name].push(value);
    }
    byType.set(sample.dynoType, group);
  }

  return [...byType].flatMap(([dynoType, group]) => {
    const chunks = Math.max(
      Math.ceil(group.MemoryUtilization.length / EMF_MAX_VALUES_PER_METRIC),
      Math.ceil(group.LoadAvg1m.length / EMF_MAX_VALUES_PER_METRIC)
    );

    return Array.from({ length: chunks }, (_, index) => {
      const slice = values => values.slice(index * EMF_MAX_VALUES_PER_METRIC, (index + 1) * EMF_MAX_VALUES_PER_METRIC);
      const metrics = [
        { name: 'MemoryUtilization', unit: 'None', value: slice(group.MemoryUtilization) },
        { name: 'LoadAvg1m', unit: 'None', value: slice(group.LoadAvg1m) },
      ].filter(metric => metric.value.length > 0);

      return emfEvent(group.timestamp, DYNO_METRICS_NAMESPACE, { App: appName, DynoType: dynoType }, metrics);
    });
  });
}

/**
 * Builds CloudWatch embedded metric format (EMF) log events for the add-on
 * samples, router lines and dyno runtime metrics in the given raw log lines.
 * Heroku Redis samples are only published for the add-ons in redisAddons.
 */
export function buildMetricEvents(lines, { appName, redisAddons = new Set(), fallbackTimestamp = Date.now() }) {
  const samples = [];
  const requests = [];
  const dynoSamples = [];

  for (const line of lines) {
    const sample = parseAddonSample(line, fallbackTimestamp);

    if (sample) {
      if (sample.proc !== 'heroku-redis' || redisAddons.has(sample.addon)) {
        samples.push(sample);
      }
      continue;
    }

    const request = parseRouterLine(line, fallbackTimestamp);

    if (request) {
      requests.push(request);
      continue;
    }

    const dynoSample = parseDynoSample(line, fallbackTimestamp);

    if (dynoSample) {
      dynoSamples.push(dynoSample);
    }
  }

  return [
    ...samples.map(sample => addonSampleEvent(sample, appName)),
    ...routerEvents(requests, appName),
    ...dynoEvents(dynoSamples, appName),
  ].sort((first, second) => first.timestamp - second.timestamp);
}

/**
 * Parses a comma-separated environment variable into a set.
 */
export function parseList(value) {
  return new Set((value || '').split(',').map(item => item.trim()).filter(item => item !== ''));
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
