'use strict';

const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT = 12000;

/**
 * Small https helper built on the core module rather than fetch, because the
 * Antigravity language server speaks TLS on 127.0.0.1 with a self-signed cert
 * and we need per-request control over certificate checking.
 */
function request(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = DEFAULT_TIMEOUT,
    insecure = false,
  } = opts;

  const target = new URL(url);
  if (insecure && target.hostname !== '127.0.0.1' && target.hostname !== 'localhost') {
    return Promise.reject(new Error('refusing to skip certificate checks for a non-local host'));
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method,
        headers,
        rejectUnauthorized: !insecure,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function getJson(url, opts = {}) {
  const res = await request(url, opts);
  return finishJson(url, res);
}

async function postJson(url, body, opts = {}) {
  const res = await request(url, {
    ...opts,
    method: 'POST',
    body: body == null ? '{}' : body,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return finishJson(url, res);
}

function finishJson(url, res) {
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    err.status = res.status;
    err.bodyText = res.text.slice(0, 500);
    throw err;
  }
  try {
    return JSON.parse(res.text);
  } catch {
    const err = new Error(`unexpected non-JSON response from ${new URL(url).host}`);
    err.bodyText = res.text.slice(0, 200);
    throw err;
  }
}

module.exports = { request, getJson, postJson };
