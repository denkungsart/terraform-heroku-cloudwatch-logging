'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { createHandler } from './lambda_heroku_logs_index.js';

const ENV = {
  AUTH_USERNAME: 'heroku',
  AUTH_PASSWORD: 'secret',
  FIREHOSE_STREAM_NAME: 'firehose-stream',
  HEROKU_LOGS_GROUP: '/heroku/logs',
  HEROKU_LOGS_STREAM: 'heroku-logs-stream',
};

function basicAuth(username = ENV.AUTH_USERNAME, password = ENV.AUTH_PASSWORD) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function createAwsClientStub(responses = []) {
  const calls = [];

  return {
    calls,
    async send(command) {
      calls.push(command);

      const response = responses.shift();
      if (response instanceof Error) {
        throw response;
      }

      return response || {};
    },
  };
}

function createLoggerStub() {
  return {
    errors: [],
    error(...args) {
      this.errors.push(args);
    },
  };
}

test('handler rejects requests without valid Basic Auth before sending to AWS', async () => {
  const firehoseClient = createAwsClientStub();
  const logsClient = createAwsClientStub();
  const handler = createHandler({
    firehoseClient,
    logsClient,
    env: ENV,
    logger: createLoggerStub(),
  });

  const response = await handler({ headers: {}, body: 'line\n' });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.headers, { 'WWW-Authenticate': 'Basic realm="Heroku Logs"' });
  assert.equal(firehoseClient.calls.length, 0);
  assert.equal(logsClient.calls.length, 0);
});

test('handler decodes base64 bodies and writes raw logs to Firehose and processed logs to CloudWatch', async () => {
  const line = '328 <134>1 2026-05-13T08:16:55.000000+00:00 host heroku router - Error L10 output buffer overflow';
  const firehoseClient = createAwsClientStub([{ FailedPutCount: 0 }]);
  const logsClient = createAwsClientStub([
    { logStreams: [] },
    {},
    {},
  ]);
  const handler = createHandler({
    firehoseClient,
    logsClient,
    env: ENV,
    logger: createLoggerStub(),
    now: () => new Date('2026-05-13T12:00:00Z'),
  });

  const response = await handler({
    headers: { authorization: basicAuth() },
    isBase64Encoded: true,
    body: Buffer.from(`${line}\n`, 'utf8').toString('base64'),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(firehoseClient.calls.length, 1);
  assert.equal(firehoseClient.calls[0].constructor.name, 'PutRecordBatchCommand');
  assert.deepEqual(firehoseClient.calls[0].input, {
    DeliveryStreamName: ENV.FIREHOSE_STREAM_NAME,
    Records: [{ Data: `${line}\n` }],
  });

  assert.deepEqual(
    logsClient.calls.map(command => command.constructor.name),
    ['DescribeLogStreamsCommand', 'CreateLogStreamCommand', 'PutLogEventsCommand']
  );
  assert.equal(logsClient.calls[0].input.logStreamNamePrefix, 'heroku-logs-stream/2026-05-13');
  assert.deepEqual(logsClient.calls[1].input, {
    logGroupName: ENV.HEROKU_LOGS_GROUP,
    logStreamName: 'heroku-logs-stream/2026-05-13',
  });
  assert.deepEqual(logsClient.calls[2].input, {
    logGroupName: ENV.HEROKU_LOGS_GROUP,
    logStreamName: 'heroku-logs-stream/2026-05-13',
    logEvents: [{
      message: '2026-05-13T08:16:55.000000+00:00 host heroku router - Error L10 output buffer overflow',
      timestamp: Date.parse('2026-05-13T08:16:55.000000+00:00'),
    }],
  });
});

test('handler retries only failed retryable Firehose records before continuing to CloudWatch', async () => {
  const firstLine = '328 <134>1 2026-05-13T08:16:55.000000+00:00 host heroku router - first';
  const secondLine = '328 <134>1 2026-05-13T08:16:56.000000+00:00 host heroku router - second';
  const sleepDelays = [];
  const firehoseClient = createAwsClientStub([
    {
      FailedPutCount: 1,
      RequestResponses: [
        { RecordId: 'accepted' },
        { ErrorCode: 'ServiceUnavailableException', ErrorMessage: 'try again' },
      ],
    },
    { FailedPutCount: 0 },
  ]);
  const logsClient = createAwsClientStub([
    { logStreams: [{ logStreamName: 'heroku-logs-stream/2026-05-13' }] },
    {},
  ]);
  const handler = createHandler({
    firehoseClient,
    logsClient,
    env: ENV,
    logger: createLoggerStub(),
    now: () => new Date('2026-05-13T12:00:00Z'),
    sleepFn: async delay => {
      sleepDelays.push(delay);
    },
  });

  const response = await handler({
    headers: { Authorization: basicAuth() },
    body: `${firstLine}\n${secondLine}\n`,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(sleepDelays, [100]);
  assert.equal(firehoseClient.calls.length, 2);
  assert.deepEqual(
    firehoseClient.calls.map(command => command.input.Records.map(record => record.Data)),
    [
      [`${firstLine}\n`, `${secondLine}\n`],
      [`${secondLine}\n`],
    ]
  );
  assert.deepEqual(
    logsClient.calls.map(command => command.constructor.name),
    ['DescribeLogStreamsCommand', 'PutLogEventsCommand']
  );
});

test('handler returns 500 and skips CloudWatch when Firehose reports non-retryable failures', async () => {
  const line = '328 <134>1 2026-05-13T08:16:55.000000+00:00 host heroku router - dropped';
  const logger = createLoggerStub();
  const firehoseClient = createAwsClientStub([
    {
      FailedPutCount: 1,
      RequestResponses: [
        { ErrorCode: 'InvalidArgumentException', ErrorMessage: 'bad record' },
      ],
    },
  ]);
  const logsClient = createAwsClientStub();
  const handler = createHandler({
    firehoseClient,
    logsClient,
    env: ENV,
    logger,
  });

  const response = await handler({
    headers: { authorization: basicAuth() },
    body: `${line}\n`,
  });

  assert.equal(response.statusCode, 500);
  assert.match(JSON.parse(response.body).error, /Failed to deliver 1 Heroku log record/);
  assert.equal(logsClient.calls.length, 0);
  assert.equal(logger.errors.length, 2);
});

test('handler caches confirmed CloudWatch log streams across warm invocations', async () => {
  const line = '328 <134>1 2026-05-13T08:16:55.000000+00:00 host heroku router - cached';
  const firehoseClient = createAwsClientStub([
    { FailedPutCount: 0 },
    { FailedPutCount: 0 },
  ]);
  const logsClient = createAwsClientStub([
    { logStreams: [] },
    {},
    {},
    {},
  ]);
  const handler = createHandler({
    firehoseClient,
    logsClient,
    env: ENV,
    logger: createLoggerStub(),
    now: () => new Date('2026-05-13T12:00:00Z'),
  });

  const event = {
    headers: { authorization: basicAuth() },
    body: `${line}\n`,
  };

  assert.equal((await handler(event)).statusCode, 200);
  assert.equal((await handler(event)).statusCode, 200);
  assert.deepEqual(
    logsClient.calls.map(command => command.constructor.name),
    [
      'DescribeLogStreamsCommand',
      'CreateLogStreamCommand',
      'PutLogEventsCommand',
      'PutLogEventsCommand',
    ]
  );
});
