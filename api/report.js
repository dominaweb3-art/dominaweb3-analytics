const sampleReport = require('../data/report-data.json');
const {
  fetchAnalyticsEvents,
  isDatabaseConfigured,
} = require('../lib/db');

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

const ENTRY_EVENTS = new Set([
  'page_view',
  'gate_view',
  'landing_view',
  'question_view',
  'question_answer',
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

function parseNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatNumber(value) {
  return new Intl.NumberFormat('es-CO').format(Number(value) || 0);
}

function formatPercent(value, decimals = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return `0${decimals > 0 ? '.0' : ''}%`;
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

function sessionKeyFor(row) {
  return row.session_id || row.visitor_id || `event-${row.id}`;
}

function formatDeviceLabel(value) {
  const normalized = String(value || 'unknown').trim().toLowerCase();

  if (normalized === 'mobile') return 'Mobile';
  if (normalized === 'tablet') return 'Tablet';
  if (normalized === 'desktop') return 'Desktop';
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Unknown';
}

function recentEventDetail(eventName, data) {
  switch (eventName) {
    case 'page_view':
      return 'Pagina vista';
    case 'gate_view':
      return 'Filtro visto';
    case 'landing_view':
      return 'Landing vista';
    case 'question_answer':
      return `Paso ${data.step || 1} · ${String(data.answer || '').toUpperCase()} · ${formatDuration(data.dwell_ms)}`;
    case 'question_view':
      return `Paso ${data.step || 1} · vista`;
    case 'vsl_play':
      return `${data.state === 'resume' ? 'Reanudacion' : 'Reproduccion'} · ${data.time_since_gate_ms != null ? `${formatDuration(data.time_since_gate_ms)} desde el filtro` : 'VSL'}`;
    case 'vsl_pause':
      return `Pausa · ${formatDuration(data.watched_ms_total)}`;
    case 'vsl_end':
      return `Fin · ${formatDuration(data.watched_ms_total)}`;
    case 'cta_click':
      return `${data.placement || 'hero'} · ${data.label || 'CTA'}`;
    case 'offer_open':
      return data.section_label || 'Bloque abierto';
    case 'offer_close':
      return data.section_label || 'Bloque cerrado';
    case 'section_view':
      return `${data.section_label || data.section || 'Seccion'} · vista`;
    case 'section_dwell':
      return `${data.section_label || data.section || 'Seccion'} · ${formatDuration(data.dwell_ms)}`;
    case 'page_exit':
      return `Salida · ${formatDuration(data.page_total_ms)}`;
    case 'gate_exit':
      return 'Salida del filtro';
    default:
      return data.label || data.section_label || 'Interaccion registrada';
  }
}

function buildFallbackReport(periodKey) {
  const period = getPeriodConfig(periodKey);
  return {
    ...sampleReport,
    source: 'sample',
    period: period.key,
    periodLabel: period.label,
    window: period.since ? { since: period.since.toISOString(), until: period.now.toISOString() } : { allTime: true },
    totals: {
      events: sampleReport.recentEvents ? sampleReport.recentEvents.length : 0,
      sessions: sampleReport.summaryCards ? Number(String(sampleReport.summaryCards[0].value).replace(/[^0-9]/g, '')) || 0 : 0,
    },
  };
}

function buildReport(rows, periodKey) {
  const period = getPeriodConfig(periodKey);
  const sessions = new Set();
  const entrySessions = new Set();
  const pageViewSessions = new Set();
  const gateExitSessions = new Set();
  const ctaSessions = new Set();
  const vslSessions = new Set();
  const questionOneSessions = new Set();
  const questionTwoSessions = new Set();

  const pageTimes = [];
  const timeToPlay = [];
  const vslWatchBySession = new Map();

  const questionStats = new Map();
  const hotspotStats = new Map();
  const geoStats = new Map();
  const deviceStats = new Map();
  const openStats = new Map();

  let ctaClicks = 0;

  for (const row of rows) {
    const payload = row.payload || {};
    const data = payload.data || {};
    const eventName = row.event_name || payload.event || payload.eventType || 'unknown';
    const session = sessionKeyFor(row);

    sessions.add(session);

    if (ENTRY_EVENTS.has(eventName)) {
      entrySessions.add(session);
    }

    if (eventName === 'page_view') {
      pageViewSessions.add(session);
    }

    if (eventName === 'gate_exit') {
      gateExitSessions.add(session);
    }

    if (eventName === 'cta_click') {
      ctaSessions.add(session);
      ctaClicks += 1;
    }

    if (eventName === 'vsl_play') {
      vslSessions.add(session);
      const timeSinceGate = parseNumber(data.time_since_gate_ms);
      if (timeSinceGate != null) {
        timeToPlay.push(timeSinceGate);
      }
      const watch = parseNumber(data.watched_ms_total);
      if (watch != null) {
        vslWatchBySession.set(session, Math.max(vslWatchBySession.get(session) || 0, watch));
      }
    }

    if (eventName === 'vsl_pause' || eventName === 'vsl_end') {
      const watch = parseNumber(data.watched_ms_total);
      if (watch != null) {
        vslWatchBySession.set(session, Math.max(vslWatchBySession.get(session) || 0, watch));
      }
    }

    if (eventName === 'page_exit') {
      const pageTotal = parseNumber(data.page_total_ms);
      if (pageTotal != null) {
        pageTimes.push(pageTotal);
      }
    }

    if (eventName === 'question_answer' || eventName === 'question_view') {
      const step = String(data.step || '1');
      const stat = questionStats.get(step) || {
        step,
        prompt: data.question || '',
        views: 0,
        answers: 0,
        yes: 0,
        no: 0,
        dwellMs: 0,
      };

      if (eventName === 'question_view') {
        stat.views += 1;
      }

      if (eventName === 'question_answer') {
        const answer = String(data.answer || '').trim().toLowerCase();
        stat.answers += 1;
        if (answer === 'yes') {
          stat.yes += 1;
        } else {
          stat.no += 1;
        }

        if (step === '1') {
          questionOneSessions.add(session);
        } else if (step === '2') {
          questionTwoSessions.add(session);
        }
      }

      if (data.question && !stat.prompt) {
        stat.prompt = data.question;
      }

      const dwell = parseNumber(data.dwell_ms);
      if (dwell != null) {
        stat.dwellMs += dwell;
      }

      questionStats.set(step, stat);
    }

    if (eventName === 'section_view' || eventName === 'section_dwell') {
      const label = data.section_label || data.section || 'Sin etiqueta';
      const stat = hotspotStats.get(label) || {
        label,
        views: 0,
        dwellMs: 0,
        sessions: new Set(),
      };

      stat.sessions.add(session);

      if (eventName === 'section_view') {
        stat.views += 1;
      }

      if (eventName === 'section_dwell') {
        const dwell = parseNumber(data.dwell_ms);
        if (dwell != null) {
          stat.dwellMs += dwell;
        }
      }

      hotspotStats.set(label, stat);
    }

    if (eventName === 'offer_open' || eventName === 'faq_open') {
      const label = data.section_label || data.label || 'Ver exactamente que recibes al entrar';
      const stat = openStats.get(label) || {
        label,
        opens: 0,
      };

      stat.opens += 1;
      openStats.set(label, stat);
    }

    const country = String(row.country || data.country || 'Desconocido').trim() || 'Desconocido';
    const city = String(row.city || data.city || 'Sin ciudad').trim() || 'Sin ciudad';
    const countryStat = geoStats.get(country) || {
      label: country,
      sessions: new Set(),
      cities: new Map(),
    };
    countryStat.sessions.add(session);
    countryStat.cities.set(city, (countryStat.cities.get(city) || 0) + 1);
    geoStats.set(country, countryStat);

    const device = formatDeviceLabel(row.device_type || data.device_type || 'unknown');
    const deviceStat = deviceStats.get(device) || {
      label: device,
      sessions: new Set(),
    };
    deviceStat.sessions.add(session);
    deviceStats.set(device, deviceStat);
  }

  const rawPageViewCount = rows.filter((row) => row.event_name === 'page_view').length;
  const pageViewCount = Math.max(pageViewSessions.size, entrySessions.size, rawPageViewCount);
  const sessionCount = Math.max(pageViewCount, sessions.size);
  const baseCount = Math.max(sessionCount, 1);
  const averageVslWatch = average([...vslWatchBySession.values()]);
  const abandonment = sessionCount ? (gateExitSessions.size / sessionCount) * 100 : 0;

  const summaryCards = [
    {
      label: 'Sesiones',
      value: formatNumber(sessionCount),
      delta: period.label,
    },
    {
      label: 'Tiempo medio en pagina',
      value: formatDuration(average(pageTimes)),
      delta: `${pageTimes.length} salidas`,
    },
    {
      label: 'Tiempo hasta play',
      value: formatDuration(average(timeToPlay)),
      delta: `${timeToPlay.length} plays`,
    },
    {
      label: 'Tiempo en VSL',
      value: formatDuration(averageVslWatch),
      delta: `${vslWatchBySession.size} sesiones`,
    },
    {
      label: 'Clicks al pago',
      value: formatNumber(ctaClicks),
      delta: `${ctaSessions.size} sesiones`,
    },
    {
      label: 'Abandono',
      value: formatPercent(abandonment, 1),
      delta: `${gateExitSessions.size} salidas`,
    },
  ];

  const funnel = [
    {
      label: 'Pagina vista',
      value: 100,
      detail: `${formatNumber(pageViewCount)} sesiones`,
    },
    {
      label: 'Pregunta 1 respondida',
      value: Math.round((questionOneSessions.size / baseCount) * 100),
      detail: `${formatNumber(questionOneSessions.size)} sesiones`,
    },
    {
      label: 'Pregunta 2 respondida',
      value: Math.round((questionTwoSessions.size / baseCount) * 100),
      detail: `${formatNumber(questionTwoSessions.size)} sesiones`,
    },
    {
      label: 'VSL reproducido',
      value: Math.round((vslSessions.size / baseCount) * 100),
      detail: `${formatNumber(vslSessions.size)} sesiones`,
    },
    {
      label: 'CTA al pago',
      value: Math.round((ctaSessions.size / baseCount) * 100),
      detail: `${formatNumber(ctaSessions.size)} sesiones`,
    },
  ];

  const questions = [...questionStats.values()]
    .sort((a, b) => Number(a.step) - Number(b.step))
    .map((item) => {
      const answers = item.answers || 0;
      const yesPercent = answers ? Math.round((item.yes / answers) * 100) : 0;
      const noPercent = answers ? Math.round((item.no / answers) * 100) : 0;

      return {
        label: `Paso ${item.step}`,
        prompt: item.prompt,
        yes: yesPercent,
        no: noPercent,
        avgTime: formatDuration(answers ? item.dwellMs / answers : 0),
        exitAfter: formatPercent(noPercent, 0),
        detail: `${formatNumber(answers)} respuestas`,
      };
    });

  const hotspots = [...hotspotStats.values()]
    .map((item) => ({
      label: item.label,
      value: item.dwellMs + item.views * 5000,
      detail: `${item.views} vistas · ${formatDuration(item.dwellMs)}`,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);

  const geo = [...geoStats.values()]
    .map((item) => ({
      label: item.label,
      sub: [...item.cities.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([city, count]) => `${city} (${count})`)
        .join(' · ') || 'Sin ciudad',
      value: `${formatNumber(item.sessions.size)} sesiones`,
      sessions: item.sessions.size,
    }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 3)
    .map(({ sessions, ...item }) => item);

  const devices = [...deviceStats.values()]
    .map((item) => ({
      label: item.label,
      value: `${Math.round((item.sessions.size / Math.max(sessions.size || 1, 1)) * 100)}%`,
      detail: `${formatNumber(item.sessions.size)} sesiones`,
      sessions: item.sessions.size,
    }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 4)
    .map(({ sessions, ...item }) => item);

  const faq = [...openStats.values()]
    .sort((a, b) => b.opens - a.opens)
    .slice(0, 3)
    .map((item) => ({
      label: item.label,
      opens: item.opens,
      detail: 'Aperturas',
    }));

  const recentEvents = rows
    .slice(-10)
    .reverse()
    .map((row) => {
      const payload = row.payload || {};
      const data = payload.data || {};
      const eventName = row.event_name || payload.event || payload.eventType || 'unknown';
      const timestamp = row.occurred_at || row.received_at || new Date();
      const time = new Date(timestamp).toLocaleTimeString('es-CO', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

      return {
        time,
        event: eventName,
        detail: recentEventDetail(eventName, data),
      };
    });

  return {
    source: 'database',
    period: period.key,
    periodLabel: period.label,
    window: period.since ? {
      since: period.since.toISOString(),
      until: period.now.toISOString(),
    } : {
      allTime: true,
    },
    updatedAt: new Date().toISOString(),
    totals: {
      events: rows.length,
      sessions: sessionCount,
      pageViews: pageViewCount,
    },
    summaryCards,
    funnel,
    hotspots,
    questions,
    devices,
    geo,
    faq,
    recentEvents,
    collectorEndpoint: '/api/collect',
  };
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
        return res.status(200).json(buildReport(rows, periodKey));
      }
    }
  } catch (error) {
    console.error('[analytics-report-error]', error);
  }

  return res.status(200).json(buildFallbackReport(periodKey));
};