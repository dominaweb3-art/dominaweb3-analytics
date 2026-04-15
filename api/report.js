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
  const key = String(value || 'daily').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PERIODS, key) ? key : 'daily';
}

function getPeriodConfig(periodKey) {
  const config = PERIODS[periodKey] || PERIODS.daily;
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

function roundSeconds(ms) {
  return Math.max(0, Math.round((Number(ms) || 0) / 1000));
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

function sessionKeyFor(row) {
  return row.session_id || row.visitor_id || `event-${row.id}`;
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function decodeMaybe(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  try {
    return decodeURIComponent(text);
  } catch (error) {
    return text;
  }
}

function formatDeviceLabel(value) {
  const normalized = normalizeText(value || 'unknown');

  if (normalized === 'mobile') return 'Mobile';
  if (normalized === 'tablet') return 'Tablet';
  if (normalized === 'desktop') return 'Desktop';
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Unknown';
}

function safeDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pickTimestamp(row, payload) {
  return safeDate(row.occurred_at || row.received_at || payload.timestamp || payload.occurredAt || new Date().toISOString());
}

function markFirstAt(record, key, value) {
  if (!value) {
    return;
  }

  if (!record[key] || value.getTime() < record[key].getTime()) {
    record[key] = value;
  }
}

function formatPeople(count) {
  const number = Number(count) || 0;
  return `${formatNumber(number)} ${number === 1 ? 'persona' : 'personas'}`;
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
      return `${data.state === 'resume' ? 'Reanudacion' : 'Play'} · ${data.time_since_gate_ms != null ? `${formatDuration(data.time_since_gate_ms)} desde landing` : 'Video'}`;
    case 'vsl_pause':
      return `Pausa · ${formatDuration(data.watched_ms_total)}`;
    case 'vsl_end':
      return `Fin · ${formatDuration(data.watched_ms_total)}`;
    case 'cta_click':
      return `${data.placement || 'hero'} · ${data.label || 'CTA'}`;
    case 'offer_open':
      return data.section_label || 'Ver mas';
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

function createTimeline(sessionId) {
  return {
    sessionId,
    firstAt: null,
    baseAt: null,
    pageViewAt: null,
    gateViewAt: null,
    question1ViewAt: null,
    question1AnswerAt: null,
    question2ViewAt: null,
    question2AnswerAt: null,
    landingAt: null,
    vslPlayAt: null,
    offerOpenAt: null,
    socialViewAt: null,
    ctaClickAt: null,
    gateExitAt: null,
    pageExitAt: null,
    vslWatchMs: 0,
    pageTotalMs: 0,
    country: null,
    city: null,
    device: null,
  };
}

function firstExistingAt(session, keys) {
  for (const key of keys) {
    if (session[key]) {
      return session[key];
    }
  }

  return null;
}

function averageTimeBetween(sessions, currentKey, referenceKeys) {
  const values = [];

  for (const session of sessions) {
    const current = session[currentKey];
    const reference = firstExistingAt(session, referenceKeys);

    if (!current || !reference) {
      continue;
    }

    const diff = current.getTime() - reference.getTime();
    if (diff >= 0) {
      values.push(diff);
    }
  }

  return average(values);
}

function buildQuestionRows(questionStats, baseCount) {
  return [...questionStats.values()]
    .sort((a, b) => Number(a.step) - Number(b.step))
    .map((item) => {
      const answers = item.answers || 0;
      const yesPercentOfAnswers = percentValue(item.yes, Math.max(answers, 1), 0);
      const noPercentOfAnswers = percentValue(item.no, Math.max(answers, 1), 0);
      const yesPercentOfBase = percentValue(item.yes, Math.max(baseCount, 1), 0);
      const avgTimeMs = answers ? item.dwellMs / answers : 0;

      return {
        id: `question_${item.step}`,
        label: `Pregunta ${item.step}`,
        prompt: item.prompt,
        people: answers,
        yesPeople: item.yes,
        noPeople: item.no,
        yesPercentOfAnswers,
        yesPercentOfAnswersLabel: formatPercent(yesPercentOfAnswers, 0),
        noPercentOfAnswers,
        noPercentOfAnswersLabel: formatPercent(noPercentOfAnswers, 0),
        yesPercentOfBase,
        yesPercentOfBaseLabel: formatPercent(yesPercentOfBase, 0),
        avgTimeMs,
        avgTimeLabel: formatDuration(avgTimeMs),
        detail: `${formatNumber(answers)} respuestas`,
      };
    });
}

function buildFlowStep(label, people, baseCount, avgTimeMs, timeBasis, note) {
  const percentOfBase = label === 'Llegaron a la pregunta 1'
    ? 100
    : percentValue(people, Math.max(baseCount, 1), 0);

  return {
    label,
    people,
    peopleLabel: formatPeople(people),
    percentOfBase,
    percentLabel: formatPercent(percentOfBase, 0),
    avgTimeMs: avgTimeMs == null ? null : avgTimeMs,
    avgTimeSeconds: avgTimeMs == null ? null : roundSeconds(avgTimeMs),
    avgTimeLabel: avgTimeMs == null ? 'Base' : formatDuration(avgTimeMs),
    timeBasis: avgTimeMs == null ? 'Base del analisis' : timeBasis,
    note: note || '',
  };
}

function buildStoryLines(flowSteps, videoMetrics) {
  const lookup = new Map(flowSteps.map((step) => [step.label, step]));
  const base = lookup.get('Llegaron a la pregunta 1');
  const question1 = lookup.get('Respondieron la pregunta 1');
  const question2 = lookup.get('Respondieron la pregunta 2');
  const landing = lookup.get('Entraron al landing');
  const video = lookup.get('Reprodujeron el video');
  const more = lookup.get('Abrieron Ver mas');
  const social = lookup.get('Vieron la prueba social');
  const cta = lookup.get('Hicieron click en iniciar pago');

  return [
    `${base.peopleLabel} llegaron a la pregunta 1. Esta es la base del analisis.`,
    `${question1.peopleLabel} respondieron la pregunta 1 en ${question1.avgTimeLabel} promedio desde que llegaron.`,
    `${question2.peopleLabel} respondieron la pregunta 2 en ${question2.avgTimeLabel} promedio despues de responder la pregunta 1.`,
    `${landing.peopleLabel} entraron al landing. En este embudo, entrar al landing significa terminar las dos preguntas.`,
    `${video.peopleLabel} reprodujeron el video ${video.avgTimeLabel} despues de entrar al landing.`,
    `${videoMetrics.avgWatchLabel} es el tiempo promedio que vio el video la gente que dio play.`,
    `${more.peopleLabel} abrieron Ver mas ${more.avgTimeLabel} despues de entrar al landing.`,
    `${social.peopleLabel} vieron la prueba social ${social.avgTimeLabel} despues de entrar al landing.`,
    `${cta.peopleLabel} hicieron click en iniciar pago ${cta.avgTimeLabel} despues de entrar al landing.`,
  ];
}

function buildAttentionRows(offerCount, baseCount, avgOfferMs, socialCount, avgSocialMs, ctaCount, avgCtaMs) {
  return [
    {
      label: 'Abrieron Ver mas',
      people: offerCount,
      peopleLabel: formatPeople(offerCount),
      percentOfBase: percentValue(offerCount, Math.max(baseCount, 1), 0),
      percentLabel: formatPercent(percentValue(offerCount, Math.max(baseCount, 1), 0), 0),
      avgTimeMs: avgOfferMs,
      avgTimeSeconds: roundSeconds(avgOfferMs),
      avgTimeLabel: formatDuration(avgOfferMs),
      detail: 'despues de entrar al landing',
    },
    {
      label: 'Vieron la prueba social',
      people: socialCount,
      peopleLabel: formatPeople(socialCount),
      percentOfBase: percentValue(socialCount, Math.max(baseCount, 1), 0),
      percentLabel: formatPercent(percentValue(socialCount, Math.max(baseCount, 1), 0), 0),
      avgTimeMs: avgSocialMs,
      avgTimeSeconds: roundSeconds(avgSocialMs),
      avgTimeLabel: formatDuration(avgSocialMs),
      detail: 'despues de entrar al landing',
    },
    {
      label: 'Click en iniciar pago',
      people: ctaCount,
      peopleLabel: formatPeople(ctaCount),
      percentOfBase: percentValue(ctaCount, Math.max(baseCount, 1), 0),
      percentLabel: formatPercent(percentValue(ctaCount, Math.max(baseCount, 1), 0), 0),
      avgTimeMs: avgCtaMs,
      avgTimeSeconds: roundSeconds(avgCtaMs),
      avgTimeLabel: formatDuration(avgCtaMs),
      detail: 'despues de entrar al landing',
    },
  ];
}

function buildFallbackReport(periodKey) {
  const period = getPeriodConfig(periodKey);
  const sampleSessions = Number(String(sampleReport.summaryCards?.[0]?.value || '0').replace(/[^0-9]/g, '')) || 0;
  const sampleFlow = sampleReport.funnel || [];
  const sampleQuestions = sampleReport.questions || [];
  const sampleHotspots = sampleReport.hotspots || [];

  const question1Count = Math.round(sampleSessions * ((sampleFlow[1] && sampleFlow[1].value) || 0) / 100);
  const question2Count = Math.round(sampleSessions * ((sampleFlow[2] && sampleFlow[2].value) || 0) / 100);
  const landingCount = question2Count;
  const videoCount = Math.round(sampleSessions * ((sampleFlow[3] && sampleFlow[3].value) || 0) / 100);
  const ctaCount = Math.round(sampleSessions * ((sampleFlow[4] && sampleFlow[4].value) || 0) / 100);
  const moreHotspot = sampleHotspots.find((item) => normalizeText(item.label).includes('ver exactamente'));
  const socialHotspot = sampleHotspots.find((item) => normalizeText(item.label).includes('prueba social'));
  const moreCount = Math.round(sampleSessions * (Number(moreHotspot?.value) || 0) / 100);
  const socialCount = Math.round(sampleSessions * (Number(socialHotspot?.value) || 0) / 100);
  const question1AvgMs = (parseNumber(String(sampleQuestions[0]?.avgTime || '0').replace(/[^0-9.]/g, '')) || 0) * 1000;
  const question2AvgMs = (parseNumber(String(sampleQuestions[1]?.avgTime || '0').replace(/[^0-9.]/g, '')) || 0) * 1000;
  const avgPlayMs = 26000;
  const avgWatchMs = 192000;
  const avgMoreMs = 118000;
  const avgSocialMs = 145000;
  const avgCtaMs = 201000;

  const flowSteps = [
    buildFlowStep('Llegaron a la pregunta 1', sampleSessions, sampleSessions, null, null, 'Base del analisis'),
    buildFlowStep('Respondieron la pregunta 1', question1Count, sampleSessions, question1AvgMs, 'desde llegar a la pregunta 1'),
    buildFlowStep('Respondieron la pregunta 2', question2Count, sampleSessions, question2AvgMs, 'despues de responder la pregunta 1'),
    buildFlowStep('Entraron al landing', landingCount, sampleSessions, 0, 'al terminar la pregunta 2'),
    buildFlowStep('Reprodujeron el video', videoCount, sampleSessions, avgPlayMs, 'despues de entrar al landing'),
    buildFlowStep('Abrieron Ver mas', moreCount, sampleSessions, avgMoreMs, 'despues de entrar al landing'),
    buildFlowStep('Vieron la prueba social', socialCount, sampleSessions, avgSocialMs, 'despues de entrar al landing'),
    buildFlowStep('Hicieron click en iniciar pago', ctaCount, sampleSessions, avgCtaMs, 'despues de entrar al landing'),
  ];

  const videoMetrics = {
    players: videoCount,
    playersLabel: formatPeople(videoCount),
    playRate: percentValue(videoCount, Math.max(sampleSessions, 1), 0),
    playRateLabel: formatPercent(percentValue(videoCount, Math.max(sampleSessions, 1), 0), 0),
    avgTimeToPlayMs: avgPlayMs,
    avgTimeToPlaySeconds: roundSeconds(avgPlayMs),
    avgTimeToPlayLabel: formatDuration(avgPlayMs),
    avgWatchMs,
    avgWatchSeconds: roundSeconds(avgWatchMs),
    avgWatchLabel: formatDuration(avgWatchMs),
  };

  return {
    source: 'sample',
    period: period.key,
    periodLabel: period.label,
    window: period.since
      ? { since: period.since.toISOString(), until: period.now.toISOString() }
      : { allTime: true },
    updatedAt: period.now.toISOString(),
    totals: {
      events: sampleReport.recentEvents ? sampleReport.recentEvents.length : 0,
      sessions: sampleSessions,
      pageViews: sampleSessions,
    },
    summaryCards: [
      { label: 'Llegaron a la pregunta 1', value: formatNumber(sampleSessions), note: 'Base del periodo' },
      { label: 'Entraron al landing', value: formatNumber(landingCount), note: `${formatPercent(percentValue(landingCount, Math.max(sampleSessions, 1), 0), 0)} de la base` },
      { label: 'Dieron play al video', value: formatNumber(videoCount), note: `${videoMetrics.playRateLabel} de la base` },
      { label: 'Abrieron Ver mas', value: formatNumber(moreCount), note: `${formatPercent(percentValue(moreCount, Math.max(sampleSessions, 1), 0), 0)} de la base` },
      { label: 'Click en iniciar pago', value: formatNumber(ctaCount), note: `${formatPercent(percentValue(ctaCount, Math.max(sampleSessions, 1), 0), 0)} de la base` },
      { label: 'Tiempo promedio viendo video', value: videoMetrics.avgWatchLabel, note: `${formatNumber(videoCount)} personas dieron play` },
    ],
    flowSteps,
    storyLines: buildStoryLines(flowSteps, videoMetrics),
    videoMetrics,
    questions: sampleQuestions.map((item, index) => {
      const people = index === 0 ? question1Count : question2Count;
      const yesPercentOfAnswers = Number(item.yes) || 0;
      const noPercentOfAnswers = Number(item.no) || 0;
      const yesPeople = Math.round(people * yesPercentOfAnswers / 100);
      const noPeople = Math.round(people * noPercentOfAnswers / 100);
      const avgTimeMs = (parseNumber(String(item.avgTime || '0').replace(/[^0-9.]/g, '')) || 0) * 1000;

      return {
        id: `question_${index + 1}`,
        label: `Pregunta ${index + 1}`,
        prompt: item.prompt || '',
        people,
        yesPeople,
        noPeople,
        yesPercentOfAnswers,
        yesPercentOfAnswersLabel: formatPercent(yesPercentOfAnswers, 0),
        noPercentOfAnswers,
        noPercentOfAnswersLabel: formatPercent(noPercentOfAnswers, 0),
        yesPercentOfBase: percentValue(yesPeople, Math.max(sampleSessions, 1), 0),
        yesPercentOfBaseLabel: formatPercent(percentValue(yesPeople, Math.max(sampleSessions, 1), 0), 0),
        avgTimeMs,
        avgTimeLabel: formatDuration(avgTimeMs),
        detail: `${formatNumber(people)} respuestas`,
      };
    }),
    attention: buildAttentionRows(moreCount, sampleSessions, avgMoreMs, socialCount, avgSocialMs, ctaCount, avgCtaMs),
    hotspots: (sampleHotspots || []).map((item) => ({
      label: item.label,
      people: Math.round(sampleSessions * (Number(item.value) || 0) / 100),
      peopleLabel: formatPeople(Math.round(sampleSessions * (Number(item.value) || 0) / 100)),
      value: Math.round(sampleSessions * (Number(item.value) || 0) / 100),
      detail: `${item.value}% de la base en la muestra`,
    })),
    devices: (sampleReport.devices || []).map((item) => {
      const people = Math.round(sampleSessions * (Number(item.value) || 0) / 100);
      return {
        label: item.label,
        people,
        peopleLabel: formatPeople(people),
        percentOfBase: Number(item.value) || 0,
        percentLabel: formatPercent(Number(item.value) || 0, 0),
        detail: `${formatNumber(people)} personas`,
      };
    }),
    geo: (sampleReport.geo || []).map((item) => {
      const people = Number(String(item.value || '0').replace(/[^0-9]/g, '')) || 0;
      return {
        label: item.label,
        sub: item.sub || '',
        people,
        peopleLabel: formatPeople(people),
        percentOfBase: percentValue(people, Math.max(sampleSessions, 1), 0),
        percentLabel: formatPercent(percentValue(people, Math.max(sampleSessions, 1), 0), 0),
        detail: `${formatNumber(people)} personas`,
      };
    }),
    recentEvents: sampleReport.recentEvents || [],
    collectorEndpoint: '/api/collect',
  };
}

function buildReport(rows, periodKey) {
  const period = getPeriodConfig(periodKey);
  const sessions = new Map();
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
    const sessionId = sessionKeyFor(row);
    const at = pickTimestamp(row, payload);

    const timeline = sessions.get(sessionId) || createTimeline(sessionId);
    sessions.set(sessionId, timeline);

    markFirstAt(timeline, 'firstAt', at);

    if (ENTRY_EVENTS.has(eventName)) {
      markFirstAt(timeline, 'baseAt', at);
    }

    const country = decodeMaybe(row.country || data.country || 'Desconocido') || 'Desconocido';
    const city = decodeMaybe(row.city || data.city || 'Sin ciudad') || 'Sin ciudad';
    const device = formatDeviceLabel(row.device_type || data.device_type || 'unknown');

    timeline.country = timeline.country || country;
    timeline.city = timeline.city || city;
    timeline.device = timeline.device || device;

    const countryStat = geoStats.get(country) || { label: country, sessions: new Set(), cities: new Map() };
    countryStat.sessions.add(sessionId);
    countryStat.cities.set(city, (countryStat.cities.get(city) || 0) + 1);
    geoStats.set(country, countryStat);

    const deviceStat = deviceStats.get(device) || { label: device, sessions: new Set() };
    deviceStat.sessions.add(sessionId);
    deviceStats.set(device, deviceStat);

    if (eventName === 'page_view') {
      markFirstAt(timeline, 'pageViewAt', at);
    }

    if (eventName === 'gate_view') {
      markFirstAt(timeline, 'gateViewAt', at);
    }

    if (eventName === 'question_view' || eventName === 'question_answer') {
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
        if (step === '1') {
          markFirstAt(timeline, 'question1ViewAt', at);
        } else if (step === '2') {
          markFirstAt(timeline, 'question2ViewAt', at);
        }
      }

      if (eventName === 'question_answer') {
        stat.answers += 1;
        if (step === '1') {
          markFirstAt(timeline, 'question1AnswerAt', at);
        } else if (step === '2') {
          markFirstAt(timeline, 'question2AnswerAt', at);
        }

        const answer = normalizeText(data.answer || '');
        if (answer === 'yes') {
          stat.yes += 1;
        } else if (answer === 'no') {
          stat.no += 1;
        }
      }

      if (data.question && !stat.prompt) {
        stat.prompt = data.question;
      }

      const dwell = parseNumber(data.dwell_ms);
      if (dwell != null && eventName === 'question_answer') {
        stat.dwellMs += dwell;
      }

      questionStats.set(step, stat);
    }

    if (eventName === 'landing_view') {
      markFirstAt(timeline, 'landingAt', at);
    }

    if (eventName === 'vsl_play') {
      markFirstAt(timeline, 'vslPlayAt', at);
      const watch = parseNumber(data.watched_ms_total);
      if (watch != null) {
        timeline.vslWatchMs = Math.max(timeline.vslWatchMs, watch);
      }
    }

    if (eventName === 'vsl_pause' || eventName === 'vsl_end') {
      const watch = parseNumber(data.watched_ms_total);
      if (watch != null) {
        timeline.vslWatchMs = Math.max(timeline.vslWatchMs, watch);
      }
    }

    if (eventName === 'offer_open') {
      markFirstAt(timeline, 'offerOpenAt', at);
      const label = data.section_label || data.label || 'Ver mas';
      const stat = openStats.get(label) || { label, opens: 0, sessions: new Set() };
      stat.opens += 1;
      stat.sessions.add(sessionId);
      openStats.set(label, stat);
    }

    if (eventName === 'section_view' || eventName === 'section_dwell') {
      const label = data.section_label || data.section || 'Sin etiqueta';
      const normalizedLabel = normalizeText(label);
      const stat = hotspotStats.get(label) || {
        label,
        views: 0,
        dwellMs: 0,
        sessions: new Set(),
      };

      stat.sessions.add(sessionId);
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

      if (normalizedLabel.includes('prueba social')) {
        markFirstAt(timeline, 'socialViewAt', at);
      }

      if (normalizedLabel.includes('ver mas') || normalizedLabel.includes('ver exactamente')) {
        markFirstAt(timeline, 'offerOpenAt', at);
      }
    }

    if (eventName === 'cta_click') {
      markFirstAt(timeline, 'ctaClickAt', at);
      ctaClicks += 1;
    }

    if (eventName === 'gate_exit') {
      markFirstAt(timeline, 'gateExitAt', at);
    }

    if (eventName === 'page_exit') {
      markFirstAt(timeline, 'pageExitAt', at);
      const pageTotal = parseNumber(data.page_total_ms);
      if (pageTotal != null) {
        timeline.pageTotalMs = Math.max(timeline.pageTotalMs, pageTotal);
      }
    }
  }

  const sessionList = [...sessions.values()].map((timeline) => {
    if (!timeline.baseAt) {
      timeline.baseAt = timeline.question1ViewAt || timeline.gateViewAt || timeline.pageViewAt || timeline.firstAt;
    }

    if (!timeline.question1ViewAt && timeline.baseAt) {
      timeline.question1ViewAt = timeline.baseAt;
    }

    if (!timeline.landingAt && timeline.question2AnswerAt) {
      timeline.landingAt = timeline.question2AnswerAt;
    }

    return timeline;
  });

  const baseSessions = sessionList.filter((session) => session.baseAt);
  const questionOneSessions = baseSessions.filter((session) => session.question1AnswerAt);
  const questionTwoSessions = baseSessions.filter((session) => session.question2AnswerAt);
  const landingSessions = baseSessions.filter((session) => session.landingAt);
  const videoSessions = baseSessions.filter((session) => session.vslPlayAt);
  const moreSessions = baseSessions.filter((session) => session.offerOpenAt);
  const socialSessions = baseSessions.filter((session) => session.socialViewAt);
  const ctaSessions = baseSessions.filter((session) => session.ctaClickAt);
  const pageExitSessions = baseSessions.filter((session) => session.pageExitAt || session.gateExitAt);

  const baseCount = baseSessions.length;
  const question1Count = questionOneSessions.length;
  const question2Count = questionTwoSessions.length;
  const landingCount = landingSessions.length;
  const videoCount = videoSessions.length;
  const moreCount = moreSessions.length;
  const socialCount = socialSessions.length;
  const ctaCount = ctaSessions.length;

  const pageTimeAverage = average(sessionList.map((session) => session.pageTotalMs).filter((value) => value > 0));
  const questionRows = buildQuestionRows(questionStats, baseCount);
  const question1Average = questionRows[0] ? questionRows[0].avgTimeMs : 0;
  const question2Average = questionRows[1] ? questionRows[1].avgTimeMs : 0;
  const averagePlayFromLanding = averageTimeBetween(videoSessions, 'vslPlayAt', ['landingAt']);
  const averageMoreFromLanding = averageTimeBetween(moreSessions, 'offerOpenAt', ['landingAt']);
  const averageSocialFromLanding = averageTimeBetween(socialSessions, 'socialViewAt', ['landingAt']);
  const averageCtaFromLanding = averageTimeBetween(ctaSessions, 'ctaClickAt', ['landingAt']);
  const averageVslWatch = average(videoSessions.map((session) => session.vslWatchMs).filter((value) => value > 0));

  const flowSteps = [
    buildFlowStep('Llegaron a la pregunta 1', baseCount, baseCount, null, null, 'Base del analisis'),
    buildFlowStep('Respondieron la pregunta 1', question1Count, baseCount, question1Average, 'desde llegar a la pregunta 1'),
    buildFlowStep('Respondieron la pregunta 2', question2Count, baseCount, question2Average, 'despues de responder la pregunta 1'),
    buildFlowStep('Entraron al landing', landingCount, baseCount, 0, 'al terminar la pregunta 2'),
    buildFlowStep('Reprodujeron el video', videoCount, baseCount, averagePlayFromLanding, 'despues de entrar al landing'),
    buildFlowStep('Abrieron Ver mas', moreCount, baseCount, averageMoreFromLanding, 'despues de entrar al landing'),
    buildFlowStep('Vieron la prueba social', socialCount, baseCount, averageSocialFromLanding, 'despues de entrar al landing'),
    buildFlowStep('Hicieron click en iniciar pago', ctaCount, baseCount, averageCtaFromLanding, 'despues de entrar al landing'),
  ];

  const videoMetrics = {
    players: videoCount,
    playersLabel: formatPeople(videoCount),
    playRate: percentValue(videoCount, Math.max(baseCount, 1), 0),
    playRateLabel: formatPercent(percentValue(videoCount, Math.max(baseCount, 1), 0), 0),
    avgTimeToPlayMs: averagePlayFromLanding,
    avgTimeToPlaySeconds: roundSeconds(averagePlayFromLanding),
    avgTimeToPlayLabel: formatDuration(averagePlayFromLanding),
    avgWatchMs: averageVslWatch,
    avgWatchSeconds: roundSeconds(averageVslWatch),
    avgWatchLabel: formatDuration(averageVslWatch),
  };

  const summaryCards = [
    { label: 'Llegaron a la pregunta 1', value: formatNumber(baseCount), note: 'Base del periodo' },
    { label: 'Entraron al landing', value: formatNumber(landingCount), note: `${formatPercent(percentValue(landingCount, Math.max(baseCount, 1), 0), 0)} de la base` },
    { label: 'Dieron play al video', value: formatNumber(videoCount), note: `${videoMetrics.playRateLabel} de la base` },
    { label: 'Abrieron Ver mas', value: formatNumber(moreCount), note: `${formatPercent(percentValue(moreCount, Math.max(baseCount, 1), 0), 0)} de la base` },
    { label: 'Click en iniciar pago', value: formatNumber(ctaCount), note: `${formatPercent(percentValue(ctaCount, Math.max(baseCount, 1), 0), 0)} de la base` },
    { label: 'Tiempo promedio viendo video', value: videoMetrics.avgWatchLabel, note: `${formatNumber(videoCount)} personas dieron play` },
  ];

  const hotspots = [...hotspotStats.values()]
    .map((item) => ({
      label: item.label,
      people: item.sessions.size,
      peopleLabel: formatPeople(item.sessions.size),
      value: item.sessions.size,
      detail: `${formatNumber(item.sessions.size)} personas · ${formatDuration(item.dwellMs)} acumulados`,
      avgTimeLabel: item.sessions.size ? formatDuration(item.dwellMs / item.sessions.size) : '0s',
    }))
    .sort((a, b) => b.people - a.people)
    .slice(0, 6);

  const devices = [...deviceStats.values()]
    .map((item) => ({
      label: item.label,
      people: item.sessions.size,
      peopleLabel: formatPeople(item.sessions.size),
      percentOfBase: percentValue(item.sessions.size, Math.max(baseCount, 1), 0),
      percentLabel: formatPercent(percentValue(item.sessions.size, Math.max(baseCount, 1), 0), 0),
      detail: `${formatNumber(item.sessions.size)} personas`,
    }))
    .sort((a, b) => b.people - a.people)
    .slice(0, 4);

  const geo = [...geoStats.values()]
    .map((item) => ({
      label: item.label,
      sub: [...item.cities.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([city, count]) => `${city} (${count})`)
        .join(' · ') || 'Sin ciudad',
      people: item.sessions.size,
      peopleLabel: formatPeople(item.sessions.size),
      percentOfBase: percentValue(item.sessions.size, Math.max(baseCount, 1), 0),
      percentLabel: formatPercent(percentValue(item.sessions.size, Math.max(baseCount, 1), 0), 0),
      detail: `${formatNumber(item.sessions.size)} personas`,
    }))
    .sort((a, b) => b.people - a.people)
    .slice(0, 4);

  const attention = buildAttentionRows(
    moreCount,
    baseCount,
    averageMoreFromLanding,
    socialCount,
    averageSocialFromLanding,
    ctaCount,
    averageCtaFromLanding,
  );

  const recentEvents = rows
    .slice(-12)
    .reverse()
    .map((row) => {
      const payload = row.payload || {};
      const data = payload.data || {};
      const eventName = row.event_name || payload.event || payload.eventType || 'unknown';
      const timestamp = row.occurred_at || row.received_at || new Date().toISOString();

      return {
        time: new Date(timestamp).toLocaleTimeString('es-CO', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
        event: eventName,
        detail: recentEventDetail(eventName, data),
      };
    });

  return {
    source: 'database',
    period: period.key,
    periodLabel: period.label,
    window: period.since
      ? { since: period.since.toISOString(), until: period.now.toISOString() }
      : { allTime: true },
    updatedAt: new Date().toISOString(),
    totals: {
      events: rows.length,
      sessions: baseCount,
      pageViews: baseCount,
      exits: pageExitSessions.length,
      ctaClicks,
    },
    summaryCards,
    flowSteps,
    storyLines: buildStoryLines(flowSteps, videoMetrics),
    videoMetrics,
    questions: questionRows,
    attention,
    hotspots,
    devices,
    geo,
    recentEvents,
    collectorEndpoint: '/api/collect',
    notes: {
      base: 'La base del periodo siempre es la cantidad de personas que llegaron a la pregunta 1.',
      landing: 'Entrar al landing significa haber terminado las 2 preguntas.',
    },
    averages: {
      pageTimeLabel: formatDuration(pageTimeAverage),
      pageTimeMs: pageTimeAverage,
      playTimeLabel: videoMetrics.avgTimeToPlayLabel,
      watchTimeLabel: videoMetrics.avgWatchLabel,
    },
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