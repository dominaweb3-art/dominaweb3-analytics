const sampleReport = require('../data/report-lite.json');
const { fetchAnalyticsEvents, isDatabaseConfigured } = require('../lib/db');

const TIME_ZONE = 'America/Bogota';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

const PERIODS = {
  realtime: { label: 'Tiempo real', windowMinutes: 15 },
  daily: { label: 'Ultimas 24 horas', windowHours: 24 },
  weekly: { label: 'Ultimos 7 dias', windowDays: 7 },
  monthly: { label: 'Ultimos 30 dias', windowDays: 30 },
  'all-time': { label: 'Todo el tiempo', allTime: true },
};

const PAYMENT_START_EVENTS = new Set([
  'payment_start',
  'checkout_start',
  'start_payment',
  'initiate_payment',
]);

const PURCHASE_EVENTS = new Set([
  'purchase',
  'checkout_complete',
  'payment_complete',
  'order_complete',
  'complete_purchase',
]);

const CONTENT_EVENTS = new Set([
  'content_view',
  'content_seen',
  'vsl_play',
  'vsl_end',
  'landing_view',
  'section_view',
  'offer_open',
]);

function normalizePeriod(value) {
  const key = String(value || 'all-time').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PERIODS, key) ? key : 'all-time';
}

function getPeriodConfig(periodKey) {
  const config = PERIODS[periodKey] || PERIODS['all-time'];
  const now = new Date();
  let since = null;

  if (config.windowMinutes) {
    since = new Date(now.getTime() - config.windowMinutes * 60 * 1000);
  } else if (config.windowHours) {
    since = new Date(now.getTime() - config.windowHours * 60 * 60 * 1000);
  } else if (config.windowDays) {
    since = new Date(now.getTime() - config.windowDays * 24 * 60 * 60 * 1000);
  }

  return {
    key: periodKey,
    label: config.label,
    since,
    now,
  };
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeEventName(value) {
  return normalizeText(value).replace(/\s+/g, '_');
}

function formatNumber(value) {
  return new Intl.NumberFormat('es-CO').format(Number(value) || 0);
}

function formatPercent(value, decimals = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return `${decimals > 0 ? '0.0' : '0'}%`;
  }

  return `${number.toFixed(decimals)}%`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

function average(values) {
  if (!values.length) {
    return 0;
  }

  const total = values.reduce((sum, value) => sum + (Number(value) || 0), 0);
  return total / values.length;
}

function percentValue(numerator, denominator, decimals = 0) {
  if (!denominator) {
    return 0;
  }

  const value = (Number(numerator) / Number(denominator)) * 100;
  return Number(value.toFixed(decimals));
}

function parseNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatBogotaParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function dayKey(date) {
  const parts = formatBogotaParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dayLabel(date) {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: TIME_ZONE,
    day: '2-digit',
    month: 'short',
  }).format(date).replace(/\./g, '');
}

function dateTimeLabel(date) {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function sessionKeyFor(row) {
  return row.session_id || row.visitor_id || `event-${row.id}`;
}

function pickTimestamp(row, payload) {
  return safeDate(row.occurred_at || row.received_at || payload.timestamp || payload.occurredAt || new Date().toISOString()) || new Date();
}

function payloadData(payload) {
  return payload && typeof payload.data === 'object' && payload.data !== null ? payload.data : {};
}

function textFromPayload(payload, data) {
  return normalizeText([
    payload.event,
    payload.eventType,
    payload.name,
    data.label,
    payload.label,
    data.text,
    payload.text,
    data.cta,
    payload.cta,
    data.action,
    payload.action,
    data.section_label,
    payload.section_label,
    data.section,
    payload.section,
  ].filter(Boolean).join(' '));
}

function extractWatchMs(payload, data) {
  const raw = [
    data.watched_ms_total,
    data.watch_ms,
    data.content_watch_ms,
    data.contentWatchMs,
    data.duration_ms,
    data.dwell_ms,
    payload.watched_ms_total,
    payload.watch_ms,
    payload.content_watch_ms,
    payload.contentWatchMs,
    payload.duration_ms,
    payload.dwell_ms,
  ];

  for (const value of raw) {
    const number = parseNumber(value);
    if (number != null && number > 0) {
      return number;
    }
  }

  return 0;
}

function isPaymentStartEvent(eventName, payload, data) {
  if (PAYMENT_START_EVENTS.has(eventName)) {
    return true;
  }

  if (eventName === 'cta_click') {
    const text = textFromPayload(payload, data);
    return /pago|pagar|checkout|comprar|empezar|iniciar/.test(text);
  }

  return false;
}

function isPurchaseEvent(eventName, payload, data) {
  if (PURCHASE_EVENTS.has(eventName)) {
    return true;
  }

  const text = textFromPayload(payload, data);
  return /compra|purchase|paid|pagado|finalizado/.test(text);
}

function isContentEvent(eventName, payload, data, watchMs) {
  if (CONTENT_EVENTS.has(eventName)) {
    return true;
  }

  if (watchMs > 0) {
    return true;
  }

  const text = textFromPayload(payload, data);
  return /video|vsl|contenido|watch|landing|presentacion|presentación/.test(text);
}

function recentEventDetail(eventName, data, watchMs) {
  switch (eventName) {
    case 'payment_start':
    case 'checkout_start':
    case 'start_payment':
    case 'initiate_payment':
      return 'Inicio de pago';
    case 'cta_click':
      return 'Click en iniciar pago';
    case 'purchase':
    case 'checkout_complete':
    case 'payment_complete':
    case 'order_complete':
    case 'complete_purchase':
      return 'Compra completada';
    case 'content_view':
    case 'content_seen':
      return watchMs > 0 ? `Contenido visto durante ${formatDuration(watchMs)}` : 'Contenido visto';
    case 'vsl_play':
      return watchMs > 0 ? `Play con ${formatDuration(watchMs)} vistos` : 'Play del video';
    case 'vsl_end':
      return watchMs > 0 ? `Video finalizado con ${formatDuration(watchMs)}` : 'Video finalizado';
    case 'landing_view':
      return 'Landing vista';
    case 'section_view':
      return data.section_label || data.section || 'Seccion vista';
    case 'offer_open':
      return data.section_label || 'Bloque abierto';
    default:
      return data.label || data.section_label || 'Actividad relevante';
  }
}

function buildSummaryCards(report) {
  const paymentStarts = report.totals.paymentStarts || 0;
  const purchases = report.totals.purchases || 0;
  const contentViewed = report.totals.contentViewed || 0;
  const contentViewedRate = report.contentSplit.viewedRate || 0;

  return [
    {
      label: 'Inicios de pago',
      value: formatNumber(paymentStarts),
      note: 'Sesiones con intención',
    },
    {
      label: 'Compras',
      value: formatNumber(purchases),
      note: paymentStarts ? `${formatPercent(percentValue(purchases, paymentStarts, 0), 0)} de los inicios` : 'Sin base',
    },
    {
      label: 'Días con inicio de pago',
      value: formatNumber(report.totals.daysWithPaymentStarts || 0),
      note: 'Solo días con movimiento',
    },
    {
      label: 'Contenido visto',
      value: formatPercent(contentViewedRate, 0),
      note: paymentStarts ? `${formatNumber(contentViewed)} de ${formatNumber(paymentStarts)} inicios` : 'Sin base',
    },
    {
      label: 'Tiempo medio viendo contenido',
      value: report.contentSplit.avgWatchLabel || '0s',
      note: paymentStarts ? 'Solo sesiones con contenido' : 'Sin base',
    },
  ];
}

function buildSampleReport(periodKey) {
  const period = getPeriodConfig(periodKey);
  const dailyRows = Array.isArray(sampleReport.dailyRows) ? sampleReport.dailyRows : [];
  const contentSplit = sampleReport.contentSplit || {};
  const recentEvents = Array.isArray(sampleReport.recentEvents) ? sampleReport.recentEvents : [];
  const paymentStarts = dailyRows.reduce((sum, row) => sum + (Number(row.paymentStarts) || 0), 0);
  const purchases = dailyRows.reduce((sum, row) => sum + (Number(row.purchases) || 0), 0);
  const daysWithPaymentStarts = dailyRows.filter((row) => Number(row.paymentStarts) > 0).length;
  const contentViewed = dailyRows.reduce((sum, row) => sum + (Number(row.contentViewed) || 0), 0);
  const contentNotViewed = dailyRows.reduce((sum, row) => sum + (Number(row.contentNotViewed) || 0), 0);
  const avgWatchMs = contentSplit.avgWatchMs || average(dailyRows.map((row) => row.avgContentWatchMs).filter(Boolean));

  const report = {
    source: 'sample',
    period: period.key,
    periodLabel: period.label,
    window: period.since
      ? { since: period.since.toISOString(), until: period.now.toISOString() }
      : { allTime: true },
    updatedAt: sampleReport.updatedAt || period.now.toISOString(),
    totals: {
      events: recentEvents.length,
      sessions: paymentStarts,
      paymentStarts,
      purchases,
      daysWithPaymentStarts,
      contentViewed,
      contentNotViewed,
    },
    contentSplit: {
      viewed: contentSplit.viewed || contentViewed,
      notViewed: contentSplit.notViewed || contentNotViewed,
      viewedRate: contentSplit.viewedRate || percentValue(contentViewed, Math.max(paymentStarts, 1), 0),
      viewedRateLabel: contentSplit.viewedRateLabel || formatPercent(percentValue(contentViewed, Math.max(paymentStarts, 1), 0), 0),
      avgWatchMs,
      avgWatchLabel: contentSplit.avgWatchLabel || formatDuration(avgWatchMs),
    },
    dailyRows,
    recentEvents,
    notes: sampleReport.notes || {
      base: 'La base del periodo son las sesiones que iniciaron pago.',
      paymentStart: 'Iniciar pago incluye el CTA principal y eventos equivalentes de checkout.',
      content: 'Contenido visto significa play real o watch time medible.',
    },
  };

  report.summaryCards = sampleReport.summaryCards || buildSummaryCards(report);
  return report;
}

function createDayBucket(dayMap, date) {
  const key = dayKey(date);
  if (!dayMap.has(key)) {
    dayMap.set(key, {
      key,
      date,
      paymentStarts: 0,
      purchases: 0,
      contentViewed: 0,
      contentNotViewed: 0,
      watchMs: 0,
      watchViewedCount: 0,
    });
  }

  const bucket = dayMap.get(key);
  if (date.getTime() > bucket.date.getTime()) {
    bucket.date = date;
  }

  return bucket;
}

function buildRealReport(rows, periodKey) {
  const period = getPeriodConfig(periodKey);
  const sessions = new Map();
  const dayMap = new Map();
  const recent = [];

  for (const row of rows) {
    const payload = row.payload || {};
    const data = payloadData(payload);
    const rawEvent = row.event_name || payload.event || payload.eventType || payload.name || 'unknown';
    const eventName = normalizeEventName(rawEvent);
    const timestamp = pickTimestamp(row, payload);
    const sessionId = sessionKeyFor(row);
    const watchMs = extractWatchMs(payload, data);

    const session = sessions.get(sessionId) || {
      paymentStartAt: null,
      purchaseAt: null,
      contentViewed: false,
      contentWatchMs: 0,
    };

    if (isPaymentStartEvent(eventName, payload, data) && (!session.paymentStartAt || timestamp < session.paymentStartAt)) {
      session.paymentStartAt = timestamp;
    }

    if (isPurchaseEvent(eventName, payload, data) && (!session.purchaseAt || timestamp < session.purchaseAt)) {
      session.purchaseAt = timestamp;
    }

    if (isContentEvent(eventName, payload, data, watchMs)) {
      session.contentViewed = true;
    }

    if (watchMs > session.contentWatchMs) {
      session.contentWatchMs = watchMs;
    }

    sessions.set(sessionId, session);

    const relevant = isPaymentStartEvent(eventName, payload, data) || isPurchaseEvent(eventName, payload, data) || isContentEvent(eventName, payload, data, watchMs);
    if (relevant) {
      recent.push({
        timestamp,
        event: eventName,
        detail: recentEventDetail(eventName, data, watchMs),
      });
    }
  }

  const paymentStartSessions = [];
  const purchaseSessions = [];
  const contentViewedSessions = [];

  for (const session of sessions.values()) {
    if (session.paymentStartAt) {
      paymentStartSessions.push(session);
      const bucket = createDayBucket(dayMap, session.paymentStartAt);
      bucket.paymentStarts += 1;

      if (session.contentViewed) {
        bucket.contentViewed += 1;
        bucket.watchMs += session.contentWatchMs;
        bucket.watchViewedCount += 1;
      } else {
        bucket.contentNotViewed += 1;
      }

      if (session.contentViewed) {
        contentViewedSessions.push(session);
      }
    }

    if (session.purchaseAt) {
      purchaseSessions.push(session);
      const bucket = createDayBucket(dayMap, session.purchaseAt);
      bucket.purchases += 1;
    }
  }

  const dailyRows = [...dayMap.values()]
    .map((bucket) => {
      const avgWatchMs = bucket.watchViewedCount ? bucket.watchMs / bucket.watchViewedCount : 0;
      const viewedRate = bucket.paymentStarts ? percentValue(bucket.contentViewed, bucket.paymentStarts, 0) : 0;
      return {
        label: dayLabel(bucket.date),
        isoDate: bucket.key,
        paymentStarts: bucket.paymentStarts,
        purchases: bucket.purchases,
        contentViewed: bucket.contentViewed,
        contentNotViewed: bucket.contentNotViewed,
        avgContentWatchMs: avgWatchMs,
        avgContentWatchLabel: formatDuration(avgWatchMs),
        viewedRateLabel: formatPercent(viewedRate, 0),
      };
    })
    .sort((a, b) => b.isoDate.localeCompare(a.isoDate));

  const paymentStarts = paymentStartSessions.length;
  const purchases = purchaseSessions.length;
  const contentViewed = contentViewedSessions.length;
  const contentNotViewed = Math.max(paymentStarts - contentViewed, 0);
  const avgWatchMs = contentViewed
    ? average(contentViewedSessions.map((session) => session.contentWatchMs).filter((value) => value > 0))
    : 0;
  const daysWithPaymentStarts = dailyRows.filter((row) => Number(row.paymentStarts) > 0).length;

  const report = {
    source: 'database',
    period: period.key,
    periodLabel: period.label,
    window: period.since
      ? { since: period.since.toISOString(), until: period.now.toISOString() }
      : { allTime: true },
    updatedAt: new Date().toISOString(),
    totals: {
      events: rows.length,
      sessions: sessions.size,
      paymentStarts,
      purchases,
      daysWithPaymentStarts,
      contentViewed,
      contentNotViewed,
    },
    contentSplit: {
      viewed: contentViewed,
      notViewed: contentNotViewed,
      viewedRate: percentValue(contentViewed, Math.max(paymentStarts, 1), 0),
      viewedRateLabel: formatPercent(percentValue(contentViewed, Math.max(paymentStarts, 1), 0), 0),
      avgWatchMs,
      avgWatchLabel: formatDuration(avgWatchMs),
    },
    dailyRows,
    recentEvents: recent
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, 12)
      .map((item) => ({
        time: dateTimeLabel(item.timestamp),
        event: item.event,
        detail: item.detail,
      })),
    notes: {
      base: 'La base del periodo son las sesiones que iniciaron pago.',
      paymentStart: 'Iniciar pago incluye el CTA principal y eventos equivalentes de checkout.',
      content: 'Contenido visto significa play real o watch time medible.',
    },
  };

  report.summaryCards = buildSummaryCards(report);
  return report;
}

module.exports = async (req, res) => {
  Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, message: 'Use GET or OPTIONS' });
  }

  const periodKey = normalizePeriod(req.query.period);
  const period = getPeriodConfig(periodKey);

  try {
    if (isDatabaseConfigured()) {
      const rows = await fetchAnalyticsEvents({
        since: period.since,
        order: 'asc',
      });

      if (rows) {
        return res.status(200).json(buildRealReport(rows, periodKey));
      }
    }
  } catch (error) {
    console.error('[analytics-report-lite-error]', error);
  }

  return res.status(200).json(buildSampleReport(periodKey));
};