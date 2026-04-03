require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_HISTORY = 5;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '4mb' }));

// CORS
app.use((req, res, next) => {
  const allowed = [
    (process.env.FRONTEND_URL || '').replace(/\/$/, ''),
    'https://fuelplan.fit',
    'https://www.fuelplan.fit',
    'https://fuelplan.netlify.app',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
  ].filter(Boolean);

  const origin = req.headers.origin;

  // Allow if no origin (direct API calls, mobile apps) or origin is in allowlist
  if (!origin || allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  } else {
    // Still allow — don't block unknown origins, just don't echo them
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Input sanitization ────────────────────────────────────────────────────────
function sanitizeUserContent(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(msg => {
    if (typeof msg.content !== 'string') return msg;
    if (msg.content.length > 3000) {
      console.warn('Message content truncated');
      msg.content = msg.content.slice(0, 3000);
    }
    return msg;
  });
}

// ── Admin middleware ──────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.body?.adminKey;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Serve admin dashboard ─────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'fuelplan-backend' });
});

// ── Redis: code registry (stored as a Redis Set) ──────────────────────────────
async function getAllCodes() {
  const result = await redisCommand('SMEMBERS', 'fuelplan:codes');
  return Array.isArray(result) ? result.map(c => c.toUpperCase()).sort() : [];
}

async function codeExists(code) {
  const result = await redisCommand('SISMEMBER', 'fuelplan:codes', code.toUpperCase());
  return result === 1;
}

async function addCode(code) {
  await redisCommand('SADD', 'fuelplan:codes', code.toUpperCase());
}

async function removeCode(code) {
  await redisCommand('SREM', 'fuelplan:codes', code.toUpperCase());
}

// ── Validate code (checks Redis, falls back to env var for migration) ─────────
async function validateCode(code) {
  if (!code) return false;
  const c = code.trim().toUpperCase();
  // Check Redis set first
  const inRedis = await codeExists(c);
  if (inRedis) return true;
  // Fallback: env var (for existing codes during migration)
  const envCodes = (process.env.ACTIVATION_CODES || '')
    .split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
  if (envCodes.includes(c)) {
    // Migrate to Redis automatically
    await addCode(c);
    return true;
  }
  return false;
}

// ── Main Claude proxy ─────────────────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  const { activationCode, planMeta, ...payload } = req.body;

  if (!activationCode) return res.status(401).json({ error: 'No activation code provided' });

  const code = activationCode.trim().toUpperCase();

  // Run validation + remaining check IN PARALLEL — saves ~150-300ms of serial Redis round trips
  const [valid, remaining] = await Promise.all([
    validateCode(code),
    getRemaining(code)
  ]);

  if (!valid) return res.status(403).json({ error: 'Invalid activation code' });

  if (remaining === null) {
    // First use — set default, fire and forget (don't block the request)
    setRemaining(code, parseInt(process.env.DEFAULT_PLAN_LIMIT) || 10).catch(() => {});
  } else if (remaining <= 0) {
    return res.status(402).json({
      error: 'Plan limit reached',
      message: 'You have used all your meal plans. Contact us to top up your code.',
      remaining: 0
    });
  }

  if (payload.messages) payload.messages = sanitizeUserContent(payload.messages);

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        timeout: 120000
      }
    );

    // Fire Redis writes in parallel after Anthropic responds — client doesn't wait for these
    const writes = [decrementRemaining(code)];
    if (planMeta) writes.push(saveToHistory(code, planMeta));
    Promise.all(writes).catch(err => console.error('Post-write error:', err.message));

    return res.status(response.status).json(response.data);

  } catch (err) {
    const anthropicMsg = err.response?.data?.error?.message;
    const isTimeout = err.code === 'ECONNABORTED' || err.message.includes('timeout');
    if (isTimeout) return res.status(504).json({ error: 'Request timed out — please try again.' });
    if (err.response?.status === 529 || err.response?.status === 503) {
      return res.status(503).json({ error: 'Claude API is temporarily overloaded — please try again in a moment.' });
    }
    return res.status(500).json({ error: anthropicMsg || 'Claude API error — please try again.' });
  }
});

// ── History endpoints ─────────────────────────────────────────────────────────
app.post('/api/history/save', async (req, res) => {
  const { activationCode, plan, userName, planName, macros } = req.body;
  if (!activationCode) return res.status(401).json({ error: 'No code' });
  const code = activationCode.trim().toUpperCase();
  if (!await validateCode(code)) return res.status(403).json({ error: 'Invalid code' });
  if (!plan) return res.status(400).json({ error: 'No plan data' });

  const entry = {
    id: Date.now(),
    savedAt: new Date().toISOString(),
    userName: userName || 'User',
    planName: planName || 'My Plan',
    macros: macros || plan.summary,
    plan
  };

  try {
    await saveToHistory(code, entry);
    return res.json({ ok: true, id: entry.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/history/get', async (req, res) => {
  const { activationCode } = req.body;
  if (!activationCode) return res.status(401).json({ error: 'No code' });
  const code = activationCode.trim().toUpperCase();
  if (!await validateCode(code)) return res.status(403).json({ error: 'Invalid code' });

  try {
    const history = await getHistory(code);
    return res.json({ history: history.map(e => ({ id: e.id, savedAt: e.savedAt, userName: e.userName, planName: e.planName, macros: e.macros })) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/history/restore', async (req, res) => {
  const { activationCode, planId } = req.body;
  if (!activationCode) return res.status(401).json({ error: 'No code' });
  const code = activationCode.trim().toUpperCase();
  if (!await validateCode(code)) return res.status(403).json({ error: 'Invalid code' });
  if (!planId) return res.status(400).json({ error: 'No planId' });

  try {
    const history = await getHistory(code);
    const entry = history.find(e => e.id === planId);
    if (!entry) return res.status(404).json({ error: 'Plan not found' });
    return res.json({ plan: entry.plan, userName: entry.userName, planName: entry.planName, savedAt: entry.savedAt });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Delete a plan from history ────────────────────────────────────────────────
app.post('/api/history/delete', async (req, res) => {
  const { activationCode, planId } = req.body;
  if (!activationCode) return res.status(401).json({ error: 'No code' });
  const code = activationCode.trim().toUpperCase();
  if (!await validateCode(code)) return res.status(403).json({ error: 'Invalid code' });
  if (!planId) return res.status(400).json({ error: 'No planId' });

  try {
    let history = await getHistory(code);
    const before = history.length;
    history = history.filter(e => e.id !== planId);
    if (history.length === before) return res.status(404).json({ error: 'Plan not found' });
    await redisCommand('SET', 'fuelplan:history:' + code, JSON.stringify(history));
    return res.json({ ok: true, remaining: history.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Usage check ───────────────────────────────────────────────────────────────
app.post('/api/usage', async (req, res) => {
  const { activationCode } = req.body;
  if (!activationCode) return res.status(400).json({ error: 'No code' });
  const code = activationCode.trim().toUpperCase();
  if (!await validateCode(code)) return res.status(403).json({ error: 'Invalid code' });

  let remaining = await getRemaining(code);
  if (remaining === null) {
    const def = parseInt(process.env.DEFAULT_PLAN_LIMIT) || 10;
    remaining = def;
  }
  return res.json({ remaining });
});

// ── Admin: all codes with stats ───────────────────────────────────────────────
app.post('/api/admin/codes', requireAdmin, async (req, res) => {
  const codes = await getAllCodes();
  const results = await Promise.all(codes.map(async (code) => {
    const remaining = await getRemaining(code);
    const history = await getHistory(code);
    const note = await redisCommand('GET', 'fuelplan:note:' + code) || '';
    const last = history[0] || null;
    return {
      code,
      remaining: remaining ?? 0,
      plansUsed: history.length,
      plansSaved: history.length,
      lastUsed: last ? last.savedAt : null,
      lastUser: last ? last.userName : null,
      lastPlanName: last ? last.planName : null,
      note,
      plans: history.map(h => ({ id: h.id, planName: h.planName, savedAt: h.savedAt, userName: h.userName, macros: h.macros }))
    };
  }));
  return res.json({ codes: results });
});

// ── Admin: stats overview ─────────────────────────────────────────────────────
app.post('/api/admin/stats', requireAdmin, async (req, res) => {
  const codes = await getAllCodes();
  let totalPlansGenerated = 0;
  let activeCodes = 0;
  let codesNearLimit = 0;
  const activity = [];

  await Promise.all(codes.map(async (code) => {
    const remaining = await getRemaining(code);
    const history = await getHistory(code);
    totalPlansGenerated += history.length;
    if (history.length > 0) activeCodes++;
    if (remaining !== null && remaining <= 2 && remaining > 0) codesNearLimit++;
    history.forEach(h => activity.push({ code, savedAt: h.savedAt, userName: h.userName, planName: h.planName, macros: h.macros }));
  }));

  activity.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));

  return res.json({
    totalCodes: codes.length,
    activeCodes,
    totalPlansGenerated,
    codesNearLimit,
    recentActivity: activity.slice(0, 10)
  });
});

// ── Admin: create code (fully in Redis — no env var needed) ──────────────────
app.post('/api/admin/create-code', requireAdmin, async (req, res) => {
  const { code, plans } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  const c = code.trim().toUpperCase();
  const planCount = parseInt(plans) || parseInt(process.env.DEFAULT_PLAN_LIMIT) || 10;

  await addCode(c);
  await setRemaining(c, planCount);

  return res.json({ ok: true, code: c, plans: planCount });
});

// ── Admin: set remaining ──────────────────────────────────────────────────────
app.post('/api/admin/set-remaining', requireAdmin, async (req, res) => {
  const { code, amount } = req.body;
  if (!code || amount === undefined) return res.status(400).json({ error: 'code and amount required' });
  const c = code.trim().toUpperCase();
  await setRemaining(c, parseInt(amount));
  return res.json({ ok: true, code: c, remaining: parseInt(amount) });
});

// ── Admin: revoke code (removes from Redis set entirely) ─────────────────────
app.post('/api/admin/revoke-code', requireAdmin, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  const c = code.trim().toUpperCase();
  await removeCode(c);
  await setRemaining(c, 0);
  return res.json({ ok: true, code: c });
});

// ── Admin: history for a code ─────────────────────────────────────────────────
app.post('/api/admin/history', requireAdmin, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  const history = await getHistory(code.trim().toUpperCase());
  return res.json({ history });
});

// ── Suggestion proxy (meal swap, etc.) — validates code but does NOT decrement ─
app.post('/api/claude/suggest', async (req, res) => {
  const { activationCode, ...payload } = req.body;
  if (!activationCode) return res.status(401).json({ error: 'No activation code provided' });
  const code = activationCode.trim().toUpperCase();
  const valid = await validateCode(code);
  if (!valid) return res.status(403).json({ error: 'Invalid activation code' });
  // Cap tokens to prevent abuse
  if (payload.max_tokens && payload.max_tokens > 1200) payload.max_tokens = 1200;
  if (payload.messages) payload.messages = sanitizeUserContent(payload.messages);
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        timeout: 30000
      }
    );
    return res.status(response.status).json(response.data);
  } catch (err) {
    const isTimeout = err.code === 'ECONNABORTED' || err.message.includes('timeout');
    if (isTimeout) return res.status(504).json({ error: 'Request timed out — please try again.' });
    return res.status(500).json({ error: 'Claude API error — please try again.' });
  }
});

// ── Admin: set note for a code ────────────────────────────────────────────────
app.post('/api/admin/set-note', requireAdmin, async (req, res) => {
  const { code, note } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  const c = code.trim().toUpperCase();
  await redisCommand('SET', 'fuelplan:note:' + c, note || '');
  return res.json({ ok: true, code: c });
});

// ── Admin: health check ───────────────────────────────────────────────────────
app.get('/api/admin/health', requireAdmin, async (req, res) => {
  const t0 = Date.now();
  const result = await redisCommand('PING');
  const responseMs = Date.now() - t0;
  const redisOk = result === 'PONG';
  return res.json({ redis: redisOk ? 'ok' : 'error', responseMs });
});

// ── Admin: bulk create codes ──────────────────────────────────────────────────
app.post('/api/admin/bulk-create', requireAdmin, async (req, res) => {
  const { prefix, count, plans } = req.body;
  if (!prefix || !count) return res.status(400).json({ error: 'prefix and count required' });
  const n = Math.min(parseInt(count) || 1, 50);
  const planCount = parseInt(plans) || parseInt(process.env.DEFAULT_PLAN_LIMIT) || 10;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const created = [];

  for (let i = 0; i < n; i++) {
    let suffix = '';
    for (let j = 0; j < 6; j++) suffix += chars[Math.floor(Math.random() * chars.length)];
    const code = (prefix.trim().toUpperCase() + '-' + suffix).slice(0, 20);
    await addCode(code);
    await setRemaining(code, planCount);
    created.push(code);
  }

  return res.json({ ok: true, created, plans: planCount });
});

// ── Redis helpers ─────────────────────────────────────────────────────────────
async function redisCommand(command, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  try {
    const response = await axios.post(
      url,
      [command, ...args],
      {
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        timeout: 5000
      }
    );
    return response.data.result;
  } catch (err) {
    console.error('Redis error:', err.message);
    return null;
  }
}

async function getRemaining(code) {
  const result = await redisCommand('GET', 'fuelplan:remaining:' + code);
  if (result === null || result === undefined) return null;
  return parseInt(result, 10);
}

async function setRemaining(code, count) {
  await redisCommand('SET', 'fuelplan:remaining:' + code, count);
}

async function decrementRemaining(code) {
  await redisCommand('DECR', 'fuelplan:remaining:' + code);
}

async function getHistory(code) {
  const raw = await redisCommand('GET', 'fuelplan:history:' + code);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveToHistory(code, entry) {
  let history = await getHistory(code);
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
  await redisCommand('SET', 'fuelplan:history:' + code, JSON.stringify(history));
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Fuelplan backend running on port ${PORT}`);
});
