'use strict';

import { timingSafeEqual } from 'node:crypto';

const REQUIRED_ENV_VARS = [
  'AUTH_USERNAME',
  'AUTH_PASSWORD',
  'FIREHOSE_STREAM_NAME',
  'HEROKU_LOGS_GROUP',
  'HEROKU_LOGS_STREAM',
];

export function chunk(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

export function buildLogStreamName(baseName, requestId) {
  if (!baseName) {
    return requestId;
  }

  return `${baseName}/${requestId}`;
}

/**
 * Removes the initial formation and syslog header tokens from a log line.
 */
export function removePrefix(line) {
  return line.replace(/^\S+\s+\S+\s+/, '');
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
