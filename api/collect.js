const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

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
      message: 'Collector online. Storage not connected yet.',
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, message: 'Use GET, POST or OPTIONS' });
  }

  let payload = req.body;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (error) {
      payload = { raw: payload };
    }
  }

  const event = {
    receivedAt: new Date().toISOString(),
    eventType: payload?.eventType || payload?.event || 'unknown',
    sessionId: payload?.sessionId || null,
    page: payload?.page || null,
    step: payload?.step || null,
    answer: payload?.answer || null,
    value: payload?.value || null,
    userAgent: req.headers['user-agent'] || null,
    ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
  };

  console.log('[analytics-event]', JSON.stringify(event));

  return res.status(200).json({
    ok: true,
    endpoint: '/api/collect',
    stored: false,
    message: 'Event received. Connect storage to persist it.',
    event,
  });
};
