const { Pool } = require('pg');

let pool;
let schemaReady;

function isDatabaseConfigured() {
  return Boolean(
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL
  );
}

function getConnectionString() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    ''
  );
}

function createPool() {
  const connectionString = getConnectionString();

  if (!connectionString) {
    return null;
  }

  let hostname = '';

  try {
    hostname = new URL(connectionString).hostname;
  } catch (error) {
    hostname = '';
  }

  const useSsl = hostname && !['localhost', '127.0.0.1', '::1'].includes(hostname);

  return new Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    max: 2,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  });
}

function getPool() {
  if (!pool) {
    pool = createPool();
  }

  return pool;
}

async function ensureSchema() {
  const db = getPool();

  if (!db) {
    return false;
  }

  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS analytics_events (
          id bigserial PRIMARY KEY,
          received_at timestamptz NOT NULL DEFAULT now(),
          occurred_at timestamptz NOT NULL DEFAULT now(),
          event_name text NOT NULL,
          session_id text,
          visitor_id text,
          page text,
          path text,
          url text,
          referrer text,
          device_type text,
          country text,
          city text,
          region text,
          language text,
          timezone text,
          user_agent text,
          payload jsonb NOT NULL
        );
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS analytics_events_occurred_at_idx
        ON analytics_events (occurred_at DESC);
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS analytics_events_event_name_idx
        ON analytics_events (event_name, occurred_at DESC);
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS analytics_events_session_id_idx
        ON analytics_events (session_id, occurred_at DESC);
      `);

      return true;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }

  return schemaReady;
}

function parseOccurredAt(value) {
  if (!value) {
    return new Date();
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

async function insertAnalyticsEvent(record) {
  const db = getPool();

  if (!db) {
    return { stored: false };
  }

  await ensureSchema();

  const sql = `
    INSERT INTO analytics_events (
      occurred_at,
      event_name,
      session_id,
      visitor_id,
      page,
      path,
      url,
      referrer,
      device_type,
      country,
      city,
      region,
      language,
      timezone,
      user_agent,
      payload
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    RETURNING id, received_at, occurred_at;
  `;

  const values = [
    parseOccurredAt(record.occurredAt),
    record.eventName,
    record.sessionId || null,
    record.visitorId || null,
    record.page || null,
    record.path || null,
    record.url || null,
    record.referrer || null,
    record.deviceType || null,
    record.country || null,
    record.city || null,
    record.region || null,
    record.language || null,
    record.timezone || null,
    record.userAgent || null,
    record.payload,
  ];

  const result = await db.query(sql, values);

  return {
    stored: true,
    row: result.rows[0],
  };
}

async function fetchAnalyticsEvents({ since = null, until = null, order = 'asc', limit = null } = {}) {
  const db = getPool();

  if (!db) {
    return null;
  }

  await ensureSchema();

  const clauses = [];
  const values = [];

  if (since) {
    values.push(parseOccurredAt(since));
    clauses.push(`occurred_at >= $${values.length}`);
  }

  if (until) {
    values.push(parseOccurredAt(until));
    clauses.push(`occurred_at <= $${values.length}`);
  }

  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const direction = order === 'desc' ? 'DESC' : 'ASC';
  const limitClause = Number.isInteger(limit) && limit > 0 ? `LIMIT ${limit}` : '';

  const sql = `
    SELECT
      id,
      received_at,
      occurred_at,
      event_name,
      session_id,
      visitor_id,
      page,
      path,
      url,
      referrer,
      device_type,
      country,
      city,
      region,
      language,
      timezone,
      user_agent,
      payload
    FROM analytics_events
    ${whereClause}
    ORDER BY occurred_at ${direction}
    ${limitClause};
  `;

  const result = await db.query(sql, values);
  return result.rows;
}

module.exports = {
  ensureSchema,
  fetchAnalyticsEvents,
  insertAnalyticsEvent,
  isDatabaseConfigured,
  parseOccurredAt,
};
