const crypto = require('crypto');
const { db } = require('./db');

const OPERATION = 'POST:/incidents';
const KEY_EXPIRY = '24 hours';
const POLL_INTERVAL_MS = 30;
const POLL_TIMEOUT_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Deterministic JSON serialization: object keys are sorted so two requests
// with the same fields in a different order hash identically.
function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashRequest(body) {
  return crypto.createHash('sha256').update(canonicalize(body)).digest('hex');
}

// Waits for a concurrently-processing key owned by another request to reach
// a terminal state, then returns the appropriate response for this request.
async function waitForOutcome(tenantId, key, hash, res) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const row = await db.oneOrNone(
      `SELECT * FROM idempotency_keys WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
      [tenantId, OPERATION, key]
    );

    if (!row) {
      return res.status(409).json({ error: 'operation_in_progress' });
    }
    if (row.request_hash !== hash) {
      return res.status(409).json({ error: 'idempotency_key_conflict' });
    }
    if (row.state === 'completed') {
      res.set('Idempotent-Replayed', 'true');
      return res.status(row.response_status).json(row.response_body);
    }
    if (row.state === 'failed') {
      return res.status(409).json({ error: 'prior_operation_failed' });
    }
    if (Date.now() >= deadline) {
      return res.status(409).json({ error: 'operation_in_progress' });
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function createIncident(req, res) {
  const key = req.get('Idempotency-Key');
  if (!key) return res.status(400).json({ error: 'idempotency_key_required' });

  const tenantId = req.user.tenantId;
  const { title, severity, serviceId } = req.body;
  const hash = hashRequest(req.body);

  // Atomically claim the key: insert a fresh row, or reclaim one that expired.
  // A live, non-expired conflicting row leaves this claim empty.
  const claim = await db.oneOrNone(
    `INSERT INTO idempotency_keys (tenant_id, operation, key, request_hash, state, expires_at)
     VALUES ($1, $2, $3, $4, 'processing', now() + interval '${KEY_EXPIRY}')
     ON CONFLICT (tenant_id, operation, key) DO UPDATE
       SET request_hash = EXCLUDED.request_hash,
           state = 'processing',
           response_status = NULL,
           response_body = NULL,
           expires_at = EXCLUDED.expires_at,
           updated_at = now()
       WHERE idempotency_keys.expires_at < now()
     RETURNING *`,
    [tenantId, OPERATION, key, hash]
  );

  if (!claim) {
    return waitForOutcome(tenantId, key, hash, res);
  }

  try {
    const incident = await db.tx(async (t) => {
      const created = await t.one(
        `INSERT INTO incidents (tenant_id, service_id, title, severity)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [tenantId, serviceId, title, severity]
      );
      await t.none(
        `INSERT INTO paging_jobs (incident_id, tenant_id, status)
         VALUES ($1, $2, 'pending')`,
        [created.id, tenantId]
      );
      await t.none(
        `UPDATE idempotency_keys
         SET state = 'completed', response_status = 201, response_body = $1, updated_at = now()
         WHERE id = $2`,
        [created, claim.id]
      );
      return created;
    });
    return res.status(201).json(incident);
  } catch (err) {
    await db.none(`UPDATE idempotency_keys SET state = 'failed', updated_at = now() WHERE id = $1`, [claim.id]);
    throw err;
  }
}

module.exports = { createIncident, hashRequest };
