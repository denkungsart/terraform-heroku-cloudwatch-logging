'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCloudWatchLogEventBatches,
  buildCloudWatchLogEvents,
  buildFirehoseRecordBatches,
  buildLogStreamName,
  buildPostgresMetricEvents,
  chunk,
  CLOUDWATCH_LOGS_MAX_EVENT_MESSAGE_BYTES,
  emfFormatHeaderMiddleware,
  FIREHOSE_MAX_RECORD_BYTES,
  parseHerokuLogTimestamp,
  parsePostgresSample,
  removePrefix,
  stripAnsiEscapeCodes,
  validateBasicAuth,
  validateRequiredEnv,
} from './lambda_heroku_logs_helpers.js';

const POSTGRES_SAMPLE_LINE = '520 <134>1 2026-09-26T10:00:00.000000+00:00 host app heroku-postgres - ' +
  'source=DATABASE addon=postgresql-curly-12345 sample#current_transaction=1873 sample#db_size=26219348792bytes ' +
  'sample#tables=13 sample#active-connections=92 sample#waiting-connections=1 sample#index-cache-hit-rate=0.99723 ' +
  'sample#table-cache-hit-rate=0.99118 sample#load-avg-1m=0.39 sample#load-avg-5m=0.325 sample#load-avg-15m=0.3 ' +
  'sample#read-iops=0 sample#write-iops=112.73 sample#tmp-disk-used=543600640 sample#tmp-disk-available=72435191808 ' +
  'sample#memory-total=4045060kB sample#memory-free=159696kB sample#memory-cached=3707032kB sample#memory-postgres=182592kB';

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

test('parsePostgresSample extracts published metrics from a Heroku Postgres sample line', () => {
  assert.deepEqual(parsePostgresSample(POSTGRES_SAMPLE_LINE, 123), {
    timestamp: Date.parse('2026-09-26T10:00:00.000000+00:00'),
    database: 'DATABASE',
    addon: 'postgresql-curly-12345',
    values: {
      ReadIOPS: 0,
      WriteIOPS: 112.73,
      TableCacheHitRate: 0.99118,
      IndexCacheHitRate: 0.99723,
      MemoryCached: 3707032,
      LoadAvg1m: 0.39,
      ActiveConnections: 92,
      TmpDiskUsed: 543600640,
    },
  });
});

test('parsePostgresSample ignores lines that are not Heroku Postgres samples', () => {
  const lines = [
    '328 <134>1 2026-09-26T10:00:00.000000+00:00 host heroku router - at=info path=/',
    '328 <134>1 2026-09-26T10:00:00.000000+00:00 host app heroku-redis - source=REDIS addon=redis-1 sample#load-avg-1m=0.1',
    '328 <134>1 2026-09-26T10:00:00.000000+00:00 host app postgres.12345 - [DATABASE] LOG: checkpoint starting',
    '328 <134>1 2026-09-26T10:00:00.000000+00:00 host app heroku-postgres - source=DATABASE addon=postgresql-1 sample#tables=13',
    '328 <134>1 2026-09-26T10:00:00.000000+00:00 host app heroku-postgres - sample#read-iops=1',
    'one two',
  ];

  for (const line of lines) {
    assert.equal(parsePostgresSample(line, 123), null, line);
  }
});

test('buildPostgresMetricEvents builds EMF events for Heroku Postgres samples only', () => {
  const routerLine = '328 <134>1 2026-09-26T09:59:59.000000+00:00 host heroku router - at=info path=/';
  const events = buildPostgresMetricEvents([POSTGRES_SAMPLE_LINE, routerLine], 'prestage', 123);

  assert.equal(events.length, 1);
  assert.equal(events[0].timestamp, Date.parse('2026-09-26T10:00:00.000000+00:00'));
  assert.deepEqual(JSON.parse(events[0].message), {
    _aws: {
      Timestamp: Date.parse('2026-09-26T10:00:00.000000+00:00'),
      CloudWatchMetrics: [{
        Namespace: 'Heroku/Postgres',
        Dimensions: [['App', 'Database', 'Addon']],
        Metrics: [
          { Name: 'ReadIOPS', Unit: 'Count/Second' },
          { Name: 'WriteIOPS', Unit: 'Count/Second' },
          { Name: 'TableCacheHitRate', Unit: 'None' },
          { Name: 'IndexCacheHitRate', Unit: 'None' },
          { Name: 'MemoryCached', Unit: 'Kilobytes' },
          { Name: 'LoadAvg1m', Unit: 'None' },
          { Name: 'ActiveConnections', Unit: 'Count' },
          { Name: 'TmpDiskUsed', Unit: 'Bytes' },
        ],
      }],
    },
    App: 'prestage',
    Database: 'DATABASE',
    Addon: 'postgresql-curly-12345',
    ReadIOPS: 0,
    WriteIOPS: 112.73,
    TableCacheHitRate: 0.99118,
    IndexCacheHitRate: 0.99723,
    MemoryCached: 3707032,
    LoadAvg1m: 0.39,
    ActiveConnections: 92,
    TmpDiskUsed: 543600640,
  });
});

test('buildPostgresMetricEvents declares only the metrics present in a sample', () => {
  const line = '328 <134>1 2026-09-26T10:00:00.000000+00:00 host app heroku-postgres - ' +
    'source=HEROKU_POSTGRESQL_RED addon=postgresql-follower-1 sample#read-iops=4.5';
  const [event] = buildPostgresMetricEvents([line], 'prestage', 123);
  const message = JSON.parse(event.message);

  assert.deepEqual(message._aws.CloudWatchMetrics[0].Metrics, [{ Name: 'ReadIOPS', Unit: 'Count/Second' }]);
  assert.equal(message.Database, 'HEROKU_POSTGRESQL_RED');
  assert.equal(message.ReadIOPS, 4.5);
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
