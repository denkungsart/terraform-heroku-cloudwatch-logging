'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCloudWatchLogEventBatches,
  buildCloudWatchLogEvents,
  buildFirehoseRecordBatches,
  buildLogStreamName,
  buildMetricEvents,
  chunk,
  CLOUDWATCH_LOGS_MAX_EVENT_MESSAGE_BYTES,
  emfFormatHeaderMiddleware,
  FIREHOSE_MAX_RECORD_BYTES,
  parseHerokuLogTimestamp,
  parseAddonSample,
  parseDynoSample,
  parseList,
  parseRouterLine,
  removePrefix,
  stripAnsiEscapeCodes,
  validateBasicAuth,
  validateRequiredEnv,
} from './lambda_heroku_logs_helpers.js';

const POSTGRES_SAMPLE_LINE = '520 <134>1 2026-09-26T10:00:00.000000+00:00 host app heroku-postgres - ' +
  'source=DATABASE addon=postgresql-curly-12345 sample#current_transaction=1873 sample#db_size=26219348792bytes ' +
  'sample#db-size-percentage-used=0.02767 sample#tables=13 sample#active-connections=92 sample#waiting-connections=1 ' +
  'sample#max-connections=200 sample#connections-percentage-used=0.46 sample#index-cache-hit-rate=0.99723 ' +
  'sample#table-cache-hit-rate=0.99118 sample#load-avg-1m=0.39 sample#load-avg-5m=0.325 sample#load-avg-15m=0.3 ' +
  'sample#read-iops=0 sample#write-iops=112.73 sample#max-iops=3000 sample#iops-percentage-used=0.03758 ' +
  'sample#tmp-disk-used=543600640 sample#tmp-disk-available=72435191808 sample#memory-total=4045060kB ' +
  'sample#memory-free=159696kB sample#memory-percentage-used=0.96052 sample#memory-cached=3707032kB sample#memory-postgres=182592kB';

const REDIS_SAMPLE_LINE = '520 <134>1 2026-09-26T10:00:01+00:00 host app heroku-redis - ' +
  'source=REDIS addon=redis-pointy-52865 sample#active-connections=8 sample#max-connections=38 ' +
  'sample#connection-percentage-used=0.21053 sample#load-avg-1m=0.06 sample#read-iops=12.038 sample#memory-total=16041732kB ' +
  'sample#memory-percentage-used=0.41354 sample#memory-redis=17742928bytes sample#hit-rate=0.69551 sample#evicted-keys=0';

function dynoLine(timestamp, source, samples) {
  return `300 <45>1 ${timestamp} host heroku ${source} - source=${source} dyno=heroku.123456.0a1b2c3d-4e5f ${samples}`;
}

const DYNO_MEMORY_SAMPLES = 'sample#memory_total=384.00MB sample#memory_rss=380.10MB sample#memory_cache=3.90MB ' +
  'sample#memory_swap=0.00MB sample#memory_pgpgin=12345pages sample#memory_pgpgout=678pages sample#memory_quota=512.00MB';

function routerLine(timestamp, fields) {
  return `300 <158>1 ${timestamp} host heroku router - ${fields}`;
}

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

test('chunk splits items into fixed-size batches', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('buildLogStreamName appends UTC date to the base stream name', () => {
  assert.equal(
    buildLogStreamName('heroku-logs-stream', new Date('2026-05-13T23:59:59Z')),
    'heroku-logs-stream/2026-05-13'
  );
});

test('buildLogStreamName falls back to UTC date without a base stream name', () => {
  assert.equal(buildLogStreamName('', new Date('2026-05-13T00:00:00Z')), '2026-05-13');
});

test('removePrefix removes Heroku frame and syslog tokens while preserving message spacing', () => {
  const line = '328 <134>1 2025-01-12T20:26:22.585603+00:00 host heroku router - at=info  path=/';

  assert.equal(
    removePrefix(line),
    '2025-01-12T20:26:22.585603+00:00 host heroku router - at=info  path=/'
  );
});

test('removePrefix leaves short lines unchanged', () => {
  assert.equal(removePrefix('one two'), 'one two');
});

test('stripAnsiEscapeCodes removes terminal color sequences', () => {
  assert.equal(stripAnsiEscapeCodes('\u001b[1;34mINFO \u001b[0mpid=2'), 'INFO pid=2');
});

test('buildFirehoseRecordBatches splits records by Firehose record count limit', () => {
  const batches = buildFirehoseRecordBatches(Array.from({ length: 501 }, (_, index) => `line ${index}`));

  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 500);
  assert.equal(batches[1].length, 1);
});

test('buildFirehoseRecordBatches splits records by Firehose request byte limit', () => {
  const batches = buildFirehoseRecordBatches(Array.from({ length: 6 }, () => 'a'.repeat(800_000)));

  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 5);
  assert.equal(batches[1].length, 1);
});

test('buildFirehoseRecordBatches rejects records above the Firehose record byte limit', () => {
  assert.throws(
    () => buildFirehoseRecordBatches(['a'.repeat(FIREHOSE_MAX_RECORD_BYTES)]),
    /exceeds Firehose record limit/
  );
});

test('parseHerokuLogTimestamp reads the syslog timestamp token', () => {
  const line = '328 <134>1 2025-01-12T20:26:22.585603+00:00 host heroku router - at=info path=/';

  assert.equal(parseHerokuLogTimestamp(line, 123), Date.parse('2025-01-12T20:26:22.585603+00:00'));
});

test('parseHerokuLogTimestamp falls back when timestamp is missing or invalid', () => {
  assert.equal(parseHerokuLogTimestamp('one two', 123), 123);
  assert.equal(parseHerokuLogTimestamp('328 <134>1 invalid host heroku router - at=info', 456), 456);
});

test('buildCloudWatchLogEvents removes prefixes and sorts by event timestamp', () => {
  const later = '328 <134>1 2025-01-12T20:26:23.000000+00:00 host heroku router - at=info path=/later';
  const earlier = '328 <134>1 2025-01-12T20:26:22.000000+00:00 host heroku router - at=info path=/earlier';

  assert.deepEqual(
    buildCloudWatchLogEvents([later, earlier], 123),
    [
      {
        message: '2025-01-12T20:26:22.000000+00:00 host heroku router - at=info path=/earlier',
        timestamp: Date.parse('2025-01-12T20:26:22.000000+00:00'),
      },
      {
        message: '2025-01-12T20:26:23.000000+00:00 host heroku router - at=info path=/later',
        timestamp: Date.parse('2025-01-12T20:26:23.000000+00:00'),
      },
    ]
  );
});

test('buildCloudWatchLogEvents strips ANSI sequences from CloudWatch messages', () => {
  const line = '328 <134>1 2026-05-13T10:57:11.96214+00:00 host app worker.2 - \u001b[1;34mINFO \u001b[0mpid=2';

  assert.deepEqual(buildCloudWatchLogEvents([line]), [{
    message: '2026-05-13T10:57:11.96214+00:00 host app worker.2 - INFO pid=2',
    timestamp: Date.parse('2026-05-13T10:57:11.96214+00:00'),
  }]);
});

test('buildCloudWatchLogEventBatches splits records by CloudWatch request byte limit', () => {
  const batches = buildCloudWatchLogEventBatches([
    { message: 'a'.repeat(600_000), timestamp: 1 },
    { message: 'b'.repeat(600_000), timestamp: 2 },
  ]);

  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 1);
  assert.equal(batches[1].length, 1);
});

test('buildCloudWatchLogEventBatches splits records by CloudWatch event count limit', () => {
  const events = Array.from({ length: 10_001 }, (_, index) => ({ message: `line ${index}`, timestamp: index }));
  const batches = buildCloudWatchLogEventBatches(events);

  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 10_000);
  assert.equal(batches[1].length, 1);
});

test('buildCloudWatchLogEventBatches splits records by CloudWatch 24-hour span limit', () => {
  const batches = buildCloudWatchLogEventBatches([
    { message: 'first', timestamp: 0 },
    { message: 'second', timestamp: (24 * 60 * 60 * 1000) + 1 },
  ]);

  assert.equal(batches.length, 2);
});

test('buildCloudWatchLogEventBatches rejects messages above the CloudWatch batch byte limit', () => {
  assert.throws(
    () => buildCloudWatchLogEventBatches([
      { message: 'a'.repeat(CLOUDWATCH_LOGS_MAX_EVENT_MESSAGE_BYTES + 1), timestamp: 1 },
    ]),
    /exceeds message limit/
  );
});

test('parseAddonSample extracts published metrics from a Heroku Postgres sample line', () => {
  assert.deepEqual(parseAddonSample(POSTGRES_SAMPLE_LINE, 123), {
    proc: 'heroku-postgres',
    timestamp: Date.parse('2026-09-26T10:00:00.000000+00:00'),
    database: 'DATABASE',
    addon: 'postgresql-curly-12345',
    values: {
      ReadIOPS: 0,
      WriteIOPS: 112.73,
      IopsUtilization: 0.03758,
      TableCacheHitRate: 0.99118,
      LoadAvg1m: 0.39,
      WaitingConnections: 1,
      ConnectionsUtilization: 0.46,
      DbSizeUtilization: 0.02767,
    },
  });
});

test('parseAddonSample extracts published metrics from a Heroku Redis sample line', () => {
  assert.deepEqual(parseAddonSample(REDIS_SAMPLE_LINE, 123), {
    proc: 'heroku-redis',
    timestamp: Date.parse('2026-09-26T10:00:01+00:00'),
    database: 'REDIS',
    addon: 'redis-pointy-52865',
    values: {
      MemoryUsed: 17742928,
      ConnectionsUtilization: 0.21053,
      EvictedKeys: 0,
    },
  });
});

test('parseAddonSample ignores lines that are not add-on samples', () => {
  const lines = [
    '328 <134>1 2026-09-26T10:00:00.000000+00:00 host heroku router - at=info path=/ status=200 service=5ms',
    '328 <134>1 2026-09-26T10:00:00.000000+00:00 host app postgres.12345 - [DATABASE] LOG: checkpoint starting',
    '328 <134>1 2026-09-26T10:00:00.000000+00:00 host app heroku-postgres - source=DATABASE addon=postgresql-1 sample#tables=13',
    '328 <134>1 2026-09-26T10:00:00.000000+00:00 host app heroku-postgres - sample#read-iops=1',
    '328 <134>1 2026-09-26T10:00:00.000000+00:00 host app web.1 - source=DATABASE addon=postgresql-1 sample#read-iops=1',
    'one two',
  ];

  for (const line of lines) {
    assert.equal(parseAddonSample(line, 123), null, line);
  }
});

test('parseRouterLine reads status, service time and relevant router errors', () => {
  const timestamp = '2026-09-26T10:00:02.123456+00:00';

  assert.deepEqual(
    parseRouterLine(routerLine(timestamp, 'at=info method=GET path="/up" dyno=web.2 connect=0ms service=6ms status=302 bytes=0'), 123),
    { timestamp: Date.parse(timestamp), status: 302, serviceMs: 6, error: false }
  );
  assert.deepEqual(
    parseRouterLine(routerLine(timestamp, 'at=error code=H12 desc="Request timeout" method=GET path="/" dyno=web.1 connect=1ms service=30000ms status=503 bytes=0'), 123),
    { timestamp: Date.parse(timestamp), status: 503, serviceMs: 30000, error: true }
  );
  assert.deepEqual(
    parseRouterLine(routerLine(timestamp, 'at=info code=H80 desc="Maintenance mode" method=GET path="/up" dyno= connect=0ms service=0ms status=503 bytes=596'), 123),
    { timestamp: Date.parse(timestamp), status: 503, serviceMs: 0, error: false }
  );
  assert.equal(parseRouterLine(REDIS_SAMPLE_LINE, 123), null);
  assert.equal(parseRouterLine(routerLine(timestamp, 'at=info method=GET path="/"'), 123), null);
});

test('buildMetricEvents builds EMF events for Postgres samples and allowlisted Redis add-ons only', () => {
  const unlistedRedisLine = REDIS_SAMPLE_LINE.replace('redis-pointy-52865', 'redis-mini-1');
  const events = buildMetricEvents([REDIS_SAMPLE_LINE, POSTGRES_SAMPLE_LINE, unlistedRedisLine], {
    appName: 'prestage',
    redisAddons: new Set(['redis-pointy-52865']),
    fallbackTimestamp: 123,
  });

  assert.equal(events.length, 2);
  const [postgres, redis] = events.map(event => JSON.parse(event.message));

  assert.deepEqual(postgres._aws, {
    Timestamp: Date.parse('2026-09-26T10:00:00.000000+00:00'),
    CloudWatchMetrics: [{
      Namespace: 'Heroku/Postgres',
      Dimensions: [['App', 'Database', 'Addon']],
      Metrics: [
        { Name: 'ReadIOPS', Unit: 'Count/Second' },
        { Name: 'WriteIOPS', Unit: 'Count/Second' },
        { Name: 'IopsUtilization', Unit: 'None' },
        { Name: 'TableCacheHitRate', Unit: 'None' },
        { Name: 'LoadAvg1m', Unit: 'None' },
        { Name: 'WaitingConnections', Unit: 'Count' },
        { Name: 'ConnectionsUtilization', Unit: 'None' },
        { Name: 'DbSizeUtilization', Unit: 'None' },
      ],
    }],
  });
  assert.deepEqual(
    { App: postgres.App, Database: postgres.Database, Addon: postgres.Addon, WriteIOPS: postgres.WriteIOPS },
    { App: 'prestage', Database: 'DATABASE', Addon: 'postgresql-curly-12345', WriteIOPS: 112.73 }
  );

  assert.equal(redis._aws.CloudWatchMetrics[0].Namespace, 'Heroku/Redis');
  assert.deepEqual(
    { App: redis.App, Database: redis.Database, Addon: redis.Addon, MemoryUsed: redis.MemoryUsed, EvictedKeys: redis.EvictedKeys },
    { App: 'prestage', Database: 'REDIS', Addon: 'redis-pointy-52865', MemoryUsed: 17742928, EvictedKeys: 0 }
  );
});

test('buildMetricEvents declares only the metrics present in a sample', () => {
  const line = '328 <134>1 2026-09-26T10:00:00.000000+00:00 host app heroku-postgres - ' +
    'source=HEROKU_POSTGRESQL_RED addon=postgresql-follower-1 sample#read-iops=4.5';
  const [event] = buildMetricEvents([line], { appName: 'prestage', fallbackTimestamp: 123 });
  const message = JSON.parse(event.message);

  assert.deepEqual(message._aws.CloudWatchMetrics[0].Metrics, [{ Name: 'ReadIOPS', Unit: 'Count/Second' }]);
  assert.equal(message.Database, 'HEROKU_POSTGRESQL_RED');
  assert.equal(message.ReadIOPS, 4.5);
});

test('buildMetricEvents aggregates the router lines of a request into one event', () => {
  const lines = [
    routerLine('2026-09-26T10:00:01+00:00', 'at=info method=GET path="/" connect=0ms service=10ms status=200 bytes=1'),
    routerLine('2026-09-26T10:00:03+00:00', 'at=error code=H12 desc="Request timeout" method=GET path="/" connect=0ms service=30000ms status=503 bytes=0'),
    routerLine('2026-09-26T10:00:02+00:00', 'at=info method=GET path="/" connect=0ms service=40ms status=500 bytes=1'),
    '328 <134>1 2026-09-26T10:00:02+00:00 host app web.1 - Completed 200 OK',
  ];
  const events = buildMetricEvents(lines, { appName: 'prestage', fallbackTimestamp: 123 });

  assert.equal(events.length, 1);
  assert.equal(events[0].timestamp, Date.parse('2026-09-26T10:00:03+00:00'));
  assert.deepEqual(JSON.parse(events[0].message), {
    _aws: {
      Timestamp: Date.parse('2026-09-26T10:00:03+00:00'),
      CloudWatchMetrics: [{
        Namespace: 'Heroku/Router',
        Dimensions: [['App']],
        Metrics: [
          { Name: 'Requests', Unit: 'Count' },
          { Name: 'ServerErrors', Unit: 'Count' },
          { Name: 'RouterErrors', Unit: 'Count' },
          { Name: 'ServiceTime', Unit: 'Milliseconds' },
        ],
      }],
    },
    App: 'prestage',
    Requests: 3,
    ServerErrors: 2,
    RouterErrors: 1,
    ServiceTime: [10, 30000, 40],
  });
});

test('buildMetricEvents splits router service times into events of at most 100 values', () => {
  const lines = Array.from({ length: 250 }, (_, index) =>
    routerLine('2026-09-26T10:00:01+00:00', `at=info method=GET path="/" connect=0ms service=${index}ms status=200 bytes=1`));
  const messages = buildMetricEvents(lines, { appName: 'prestage', fallbackTimestamp: 123 }).map(event => JSON.parse(event.message));

  assert.deepEqual(messages.map(message => message.ServiceTime.length), [100, 100, 50]);
  assert.deepEqual(messages.map(message => message.Requests), [250, undefined, undefined]);
  assert.deepEqual(
    messages.map(message => message._aws.CloudWatchMetrics[0].Metrics.map(metric => metric.Name)),
    [['Requests', 'ServerErrors', 'RouterErrors', 'ServiceTime'], ['ServiceTime'], ['ServiceTime']]
  );
});

test('parseDynoSample reads memory utilization and load from runtime metrics lines', () => {
  const timestamp = '2026-09-26T10:00:05.123456+00:00';

  assert.deepEqual(parseDynoSample(dynoLine(timestamp, 'web.1', DYNO_MEMORY_SAMPLES), 123), {
    timestamp: Date.parse(timestamp),
    dynoType: 'web',
    values: { MemoryUtilization: 0.75 },
  });
  assert.deepEqual(parseDynoSample(dynoLine(timestamp, 'worker.2', 'sample#load_avg_1m=1.25 sample#load_avg_5m=0.9 sample#load_avg_15m=0.5'), 123), {
    timestamp: Date.parse(timestamp),
    dynoType: 'worker',
    values: { LoadAvg1m: 1.25 },
  });
});

test('parseDynoSample ignores one-off dynos and router, add-on and application lines', () => {
  const lines = [
    dynoLine('2026-09-26T10:00:03+00:00', 'run.1234', DYNO_MEMORY_SAMPLES),
    dynoLine('2026-09-26T10:00:03+00:00', 'release.5678', DYNO_MEMORY_SAMPLES),
    routerLine('2026-09-26T10:00:01+00:00', 'at=info method=GET path="/" dyno=web.1 connect=0ms service=10ms status=200 bytes=1'),
    POSTGRES_SAMPLE_LINE,
    REDIS_SAMPLE_LINE,
    '328 <190>1 2026-09-26T10:00:02+00:00 host app web.1 - source=web.1 sample#memory_total=1MB',
  ];

  for (const line of lines) {
    assert.equal(parseDynoSample(line, 123), null, line);
  }
});

test('buildMetricEvents publishes dyno samples per dyno type', () => {
  const lines = [
    dynoLine('2026-09-26T10:00:05+00:00', 'web.1', DYNO_MEMORY_SAMPLES),
    dynoLine('2026-09-26T10:00:06+00:00', 'web.2', DYNO_MEMORY_SAMPLES.replace('memory_total=384.00MB', 'memory_total=614.40MB')),
    dynoLine('2026-09-26T10:00:07+00:00', 'web.1', 'sample#load_avg_1m=0.5'),
    dynoLine('2026-09-26T10:00:08+00:00', 'worker.1', 'sample#load_avg_1m=2'),
  ];
  const messages = buildMetricEvents(lines, { appName: 'prestage', fallbackTimestamp: 123 }).map(event => JSON.parse(event.message));

  assert.deepEqual(messages.map(message => ({
    namespace: message._aws.CloudWatchMetrics[0].Namespace,
    dimensions: message._aws.CloudWatchMetrics[0].Dimensions,
    timestamp: message._aws.Timestamp,
    App: message.App,
    DynoType: message.DynoType,
    MemoryUtilization: message.MemoryUtilization,
    LoadAvg1m: message.LoadAvg1m,
  })), [
    {
      namespace: 'Heroku/Dyno',
      dimensions: [['App', 'DynoType']],
      timestamp: Date.parse('2026-09-26T10:00:07+00:00'),
      App: 'prestage',
      DynoType: 'web',
      MemoryUtilization: [0.75, 1.2],
      LoadAvg1m: [0.5],
    },
    {
      namespace: 'Heroku/Dyno',
      dimensions: [['App', 'DynoType']],
      timestamp: Date.parse('2026-09-26T10:00:08+00:00'),
      App: 'prestage',
      DynoType: 'worker',
      MemoryUtilization: undefined,
      LoadAvg1m: [2],
    },
  ]);
  assert.deepEqual(messages[1]._aws.CloudWatchMetrics[0].Metrics, [{ Name: 'LoadAvg1m', Unit: 'None' }]);
});

test('parseList splits comma-separated values and ignores blanks', () => {
  assert.deepEqual(parseList(' redis-a, ,redis-b,'), new Set(['redis-a', 'redis-b']));
  assert.deepEqual(parseList(undefined), new Set());
});

test('emfFormatHeaderMiddleware marks the request as EMF before passing it on', async () => {
  const args = { request: { headers: { 'content-type': 'application/x-amz-json-1.1' } } };
  const result = await emfFormatHeaderMiddleware(async passedArgs => passedArgs)(args);

  assert.deepEqual(result.request.headers, {
    'content-type': 'application/x-amz-json-1.1',
    'x-amzn-logs-format': 'json/emf',
  });
});

test('validateBasicAuth accepts matching credentials', () => {
  const env = { AUTH_USERNAME: 'heroku', AUTH_PASSWORD: 'secret:with:colons' };

  assert.equal(validateBasicAuth(basicAuth('heroku', 'secret:with:colons'), env), true);
});

test('validateBasicAuth rejects invalid credentials', () => {
  const env = { AUTH_USERNAME: 'heroku', AUTH_PASSWORD: 'secret' };

  assert.equal(validateBasicAuth(basicAuth('heroku', 'wrong'), env), false);
  assert.equal(validateBasicAuth('Bearer token', env), false);
  assert.equal(validateBasicAuth(undefined, env), false);
});

test('validateRequiredEnv reports missing Lambda configuration', () => {
  assert.throws(
    () => validateRequiredEnv({ AUTH_USERNAME: 'u' }),
    /Missing required environment variable\(s\): APP_NAME, AUTH_PASSWORD, FIREHOSE_STREAM_NAME, HEROKU_LOGS_GROUP, HEROKU_LOGS_STREAM, HEROKU_METRICS_GROUP, HEROKU_METRICS_STREAM/
  );
});
