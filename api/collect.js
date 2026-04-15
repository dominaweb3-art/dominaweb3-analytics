const {
  insertAnalyticsEvent,
  isDatabaseConfigured,
} = require('../lib/db');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

function normalizePayload(body) {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (error) {
      return { raw: body };
    }
  }

  if (body && typeof body === 'object') {
    return body;
  }

  return {};
}

function getHeader(headersMap, key) {
  return headersMap[key] || headersMap[key.toLowerCase()] || null;
}

function buildRecord(req, payload) {
  const requestHeaders = req.headers || {};
  const eventName = String(payload.event || payload.eventType || payload.name || 'unknown');
  const occurredAt = payload.timestamp || payload.occurredAt || payload.occurred_at || new Date().toISOString();
  const sessionId = payload.session_id || payload.sessionId || null;
  const visitorId = payload.visitor_id || payload.visitorId || null;
  const deviceType = payload.device_type || payload.deviceType || null;
  const country = getHeader(requestHeaders, 'x-vercel-ip-country') || payload.country || null;
  const city = getHeader(requestHeaders, 'x-vercel-ip-city') || payload.city || null;
  const region = getHeader(requestHeaders, 'x-vercel-ip-country-region') || payload.region || null;
  const userAgent = getHeader(requestHeaders, 'user-agent');

  return {
    eventName,
    occurredAt,
    sessionId,
    visitorId,
    page: payload.page || null,
    path: payload.path || null,
    url: payload.url || null,
    referrer: payload.referrer || null,
    deviceType,
    country,
    city,
    region,
    language: payload.language || null,
    timezone: payload.timezone || null,
    userAgent,
    payload,
  };
}

module.exports = async (req, res) => {
  Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      endpoint: '/api/collect',
      stored: false,
      databaseConfigured: isDatabaseConfigured(),
      message: isDatabaseConfigured()
        ? 'Collector online. Storage ready.'
        : 'Collector online. Connect a database to persist events.',
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, message: 'Use GET, POST or OPTIONS' });
  }

  const payload = normalizePayload(req.body);
  const record = buildRecord(req, payload);

  try {
    const result = await insertAnalyticsEvent(record);

    console.log('[analytics-event]', JSON.stringify({
      eventName: record.eventName,
      sessionId: record.sessionId,
      page: record.page,
      country: record.country,
      city: record.city,
      stored: result.stored,
    }));

    return res.status(200).json({
      ok: true,
      endpoint: '/api/collect',
      stored: result.stored,
      message: result.stored
        ? 'Event stored.'
        : 'Event received. Connect storage to persist it.',
      event: {
        eventName: record.eventName,
        occurredAt: record.occurredAt,
        sessionId: record.sessionId,
        page: record.page,
        country: record.country,
        city: record.city,
      },
      row: result.row || null,
    });
  } catch (error) {
    console.error('[analytics-collect-error]', error);

    return res.status(500).json({
      ok: false,
      endpoint: '/api/collect',
      stored: false,
      message: 'Failed to store event.',
    });
  }
};
