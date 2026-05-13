'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCloudWatchLogEventBatches,
  buildCloudWatchLogEvents,
  buildFirehoseRecordBatches,
  buildLogStreamName,
  chunk,
  CLOUDWATCH_LOGS_MAX_EVENT_MESSAGE_BYTES,
  FIREHOSE_MAX_RECORD_BYTES,
  parseHerokuLogTimestamp,
  removePrefix,
  stripAnsiEscapeCodes,
  validateBasicAuth,
  validateRequiredEnv,
} from './lambda_heroku_logs_helpers.js';

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
    /Missing required environment variable\(s\): AUTH_PASSWORD, FIREHOSE_STREAM_NAME, HEROKU_LOGS_GROUP, HEROKU_LOGS_STREAM/
  );
});
