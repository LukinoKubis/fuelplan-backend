require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const webPush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_HISTORY = 5;

// ── Web Push / VAPID setup ────────────────────────────────────────────────────
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BJ8LlwEHVKVb0pKlZLXVw1-rlu8rQvQ4sYccKjTlGssQRjq_xBA9lOoziy3XOk9tnugGVl0zjjpols2Xu8nnloQ';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:support@fuelplan.fit';

if (VAPID_PRIVATE_KEY) {
  try {
    webPush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  } catch (e) {
    console.error('VAPID setup failed:', e.message);
  }
}

// ── Simple in-memory rate limiter ────────────────────────────────────────────
const _rateLimitMap = new Map();
function rateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  const entry = _rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
  entry.count++;
  _rateLimitMap.set(key, entry);
  return entry.count <= maxRequests;
}
// Clean up old entries every 10 minutes
setInterval(function() {
  const now = Date.now();
  for (const [k, v] of _rateLimitMap) { if (now > v.resetAt) _rateLimitMap.delete(k); }
}, 600000);

// ── Lemon Squeezy credit map (variant ID → credits) ──────────────────────────
const LS_PLANS = {
  [process.env.LS_VARIANT_5]:  5,
  [process.env.LS_VARIANT_10]: 10,
  [process.env.LS_VARIANT_20]: 20,
};

// ── Middleware ────────────────────────────────────────────────────────────────
// LS webhook needs raw body for signature check — must come BEFORE express.json()
app.post('/api/webhook/lemonsqueezy', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = process.env.LS_WEBHOOK_SECRET;
  const signature = req.headers['x-signature'];

  if (!secret || !signature) {
    console.error('LS webhook: missing secret or signature');
    return res.status(400).send('Missing signature');
  }

  const hmac = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  if (hmac !== signature) {
    console.error('LS webhook: signature mismatch');
    return res.status(400).send('Signature mismatch');
  }

  let payload;
  try { payload = JSON.parse(req.body.toString()); } catch {
    return res.status(400).send('Invalid JSON');
  }

  const eventName = payload.meta?.event_name;
  if (eventName !== 'order_created') return res.json({ received: true });

  const order = payload.data?.attributes;
  if (!order || order.status !== 'paid') return res.json({ received: true });

  const code = (payload.meta?.custom_data?.activation_code || '').toUpperCase();
  const variantId = String(payload.data?.attributes?.first_order_item?.variant_id || '');
  const credits = LS_PLANS[variantId];

  if (!code || !credits) {
    console.error('LS webhook: missing code or unrecognised variant', { code, variantId });
    return res.json({ received: true });
  }

  const orderAttr = payload.data?.attributes || {};
  const orderRecord = {
    id: payload.data?.id || '',
    code,
    credits,
    variantId,
    total: orderAttr.total || 0,
    subtotal: orderAttr.subtotal || 0,
    tax: orderAttr.tax || 0,
    currency: (orderAttr.currency || 'EUR').toUpperCase(),
    createdAt: orderAttr.created_at || new Date().toISOString(),
    type: null,
  };

  try {
    const exists = await codeExists(code);
    orderRecord.type = exists ? 'topup' : 'new';
    if (exists) {
      await redisCommand('INCRBY', 'fuelplan:remaining:' + code, credits);
      console.log(`LS: topped up ${code} by ${credits} credits`);
    } else {
      await addCode(code);
      await redisCommand('SET', 'fuelplan:remaining:' + code, credits);
      console.log(`LS: created new code ${code} with ${credits} credits`);
    }
    await saveOrderRecord(orderRecord);
  } catch (err) {
    console.error('Redis error in LS webhook:', err);
    return res.status(500).json({ error: 'Redis error' });
  }

  res.json({ received: true });
});

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

// ── View archived plans (metadata only) ──────────────────────────────────────
app.post('/api/history/archive', async (req, res) => {
  const { activationCode } = req.body;
  if (!activationCode) return res.status(401).json({ error: 'No code' });
  const code = activationCode.trim().toUpperCase();
  if (!await validateCode(code)) return res.status(403).json({ error: 'Invalid code' });
  try {
    const raw = await redisCommand('GET', 'fuelplan:archive:' + code);
    const archive = raw ? JSON.parse(raw) : [];
    return res.json({ archive });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── User tracking data (calendar, weights, notes, water goal) ────────────────
app.post('/api/tracking/save', async (req, res) => {
  const { activationCode, data } = req.body;
  if (!activationCode) return res.status(401).json({ error: 'No code' });
  const code = activationCode.trim().toUpperCase();
  if (!rateLimit('tracking:save:' + code, 30, 60000)) return res.status(429).json({ error: 'Too many requests' });
  if (!await validateCode(code)) return res.status(403).json({ error: 'Invalid code' });
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'No data' });

  try {
    const existing = await getTrackingData(code);
    const merged = mergeTrackingData(existing, data);
    await redisCommand('SET', 'fuelplan:tracking:' + code, JSON.stringify(merged));
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/tracking/get', async (req, res) => {
  const { activationCode } = req.body;
  if (!activationCode) return res.status(401).json({ error: 'No code' });
  const code = activationCode.trim().toUpperCase();
  if (!rateLimit('tracking:get:' + code, 10, 60000)) return res.status(429).json({ error: 'Too many requests' });
  if (!await validateCode(code)) return res.status(403).json({ error: 'Invalid code' });

  try {
    const data = await getTrackingData(code);
    return res.json({ data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

async function getTrackingData(code) {
  const raw = await redisCommand('GET', 'fuelplan:tracking:' + code);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function mergeTrackingData(existing, incoming) {
  const merged = { ...existing };

  // calendarLog: union all date keys — incoming overwrites existing for same date
  if (incoming.calendarLog && typeof incoming.calendarLog === 'object') {
    merged.calendarLog = { ...(existing.calendarLog || {}), ...incoming.calendarLog };
  }

  // weights: merge by date — local (incoming) wins on conflict
  if (Array.isArray(incoming.weights)) {
    const existingByDate = {};
    (existing.weights || []).forEach(w => { existingByDate[w.date] = w; });
    incoming.weights.forEach(w => { existingByDate[w.date] = w; }); // incoming overwrites
    merged.weights = Object.values(existingByDate)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 365);
  }

  // dayNotes: union — incoming overwrites existing for same key
  if (incoming.dayNotes && typeof incoming.dayNotes === 'object') {
    merged.dayNotes = { ...(existing.dayNotes || {}), ...incoming.dayNotes };
  }

  // waterGoal: incoming wins
  if (typeof incoming.waterGoal === 'number') {
    merged.waterGoal = incoming.waterGoal;
  }

  merged.updatedAt = new Date().toISOString();
  return merged;
}

// ── Data export — dumps all user data as JSON ─────────────────────────────────
app.post('/api/export', async (req, res) => {
  const { activationCode } = req.body;
  if (!activationCode) return res.status(401).json({ error: 'No code' });
  const code = activationCode.trim().toUpperCase();
  if (!await validateCode(code)) return res.status(403).json({ error: 'Invalid code' });

  try {
    const [trackingRaw, historyRaw] = await Promise.all([
      redisCommand('GET', 'fuelplan:tracking:' + code),
      redisCommand('GET', 'fuelplan:history:' + code),
    ]);
    const tracking = trackingRaw ? JSON.parse(trackingRaw) : {};
    const history = historyRaw ? JSON.parse(historyRaw) : [];
    const remaining = await redisCommand('GET', 'fuelplan:remaining:' + code);
    const exportData = {
      exportedAt: new Date().toISOString(),
      activationCode: code,
      plansRemaining: remaining !== null ? parseInt(remaining) : null,
      savedPlans: history,
      tracking,
    };
    res.setHeader('Content-Disposition', 'attachment; filename="fuelplan-export.json"');
    res.setHeader('Content-Type', 'application/json');
    return res.json(exportData);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Web Push endpoints ────────────────────────────────────────────────────────
// Returns public VAPID key so frontend can subscribe
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Save a push subscription for a user code
app.post('/api/push/subscribe', async (req, res) => {
  const { activationCode, subscription } = req.body;
  if (!activationCode) return res.status(401).json({ error: 'No code' });
  const code = activationCode.trim().toUpperCase();
  if (!await validateCode(code)) return res.status(403).json({ error: 'Invalid code' });
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'No subscription' });

  try {
    // Store subscription (up to 3 devices per code)
    const existing = await getPushSubscriptions(code);
    const filtered = existing.filter(s => s.endpoint !== subscription.endpoint);
    filtered.unshift(subscription);
    await redisCommand('SET', 'fuelplan:push:' + code, JSON.stringify(filtered.slice(0, 3)));
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Remove push subscription
app.post('/api/push/unsubscribe', async (req, res) => {
  const { activationCode, endpoint } = req.body;
  if (!activationCode) return res.status(401).json({ error: 'No code' });
  const code = activationCode.trim().toUpperCase();
  if (!await validateCode(code)) return res.status(403).json({ error: 'Invalid code' });

  try {
    const existing = await getPushSubscriptions(code);
    const filtered = existing.filter(s => s.endpoint !== endpoint);
    await redisCommand('SET', 'fuelplan:push:' + code, JSON.stringify(filtered));
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Send a test push notification
app.post('/api/push/test', async (req, res) => {
  const { activationCode } = req.body;
  if (!activationCode) return res.status(401).json({ error: 'No code' });
  const code = activationCode.trim().toUpperCase();
  if (!await validateCode(code)) return res.status(403).json({ error: 'Invalid code' });
  if (!VAPID_PRIVATE_KEY) return res.status(503).json({ error: 'Push not configured' });

  const subs = await getPushSubscriptions(code);
  if (!subs.length) return res.status(404).json({ error: 'No subscriptions found' });

  const payload = JSON.stringify({
    title: 'Fuelplan 🌿',
    body: 'Push notifications are working! Check your plan.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'fuelplan-test'
  });

  let sent = 0;
  const staleEndpoints = [];
  await Promise.all(subs.map(async sub => {
    try {
      await webPush.sendNotification(sub, payload);
      sent++;
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        staleEndpoints.push(sub.endpoint);
      }
    }
  }));

  // Clean up stale subscriptions
  if (staleEndpoints.length) {
    const fresh = subs.filter(s => !staleEndpoints.includes(s.endpoint));
    await redisCommand('SET', 'fuelplan:push:' + code, JSON.stringify(fresh));
  }

  return res.json({ ok: true, sent, total: subs.length });
});

async function getPushSubscriptions(code) {
  const raw = await redisCommand('GET', 'fuelplan:push:' + code);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

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

// ── Email recovery ────────────────────────────────────────────────────────────
// Link an email address to an activation code (hashed for privacy)
app.post('/api/account/link-email', async (req, res) => {
  const { activationCode, email } = req.body;
  if (!activationCode || !email) return res.status(400).json({ error: 'code and email required' });
  const code = activationCode.trim().toUpperCase();
  if (!await validateCode(code)) return res.status(403).json({ error: 'Invalid code' });
  const emailClean = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean)) return res.status(400).json({ error: 'Invalid email' });
  const emailHash = crypto.createHash('sha256').update(emailClean).digest('hex');
  try {
    await redisCommand('SET', 'fuelplan:email:' + emailHash, code);
    await redisCommand('SET', 'fuelplan:email_of:' + code, emailHash);
    return res.json({ ok: true });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
});

// Send recovery email with activation code
app.post('/api/account/recover', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const emailClean = email.trim().toLowerCase();
  if (!rateLimit('recover:' + emailClean, 3, 3600000)) {
    // Still return ok to not leak whether email exists
    return res.json({ ok: true });
  }
  const emailHash = crypto.createHash('sha256').update(emailClean).digest('hex');
  try {
    const code = await redisCommand('GET', 'fuelplan:email:' + emailHash);
    if (code && process.env.RESEND_API_KEY) {
      await axios.post('https://api.resend.com/emails', {
        from: process.env.FROM_EMAIL || 'Fuelplan <noreply@fuelplan.fit>',
        to: [emailClean],
        subject: 'Your Fuelplan access code',
        html: '<p>Hi — here\'s your Fuelplan activation code: <strong>' + code + '</strong></p>'
          + '<p>Enter it at <a href="https://fuelplan.fit">fuelplan.fit</a> to access your plan.</p>'
          + '<p>— The Fuelplan team</p>'
      }, {
        headers: {
          Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
          'Content-Type': 'application/json'
        }
      });
    }
  } catch(err) {
    console.error('Email recovery error:', err.message);
  }
  // Always return ok (don't leak whether email was found)
  return res.json({ ok: true });
});

// ── Admin: set note for a code ────────────────────────────────────────────────
app.post('/api/admin/set-note', requireAdmin, async (req, res) => {
  const { code, note } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  const c = code.trim().toUpperCase();
  await redisCommand('SET', 'fuelplan:note:' + c, note || '');
  return res.json({ ok: true, code: c });
});

// ── Admin: orders ─────────────────────────────────────────────────────────────
app.post('/api/admin/orders', requireAdmin, async (req, res) => {
  const orders = await getAllOrders();
  const totalRevenue = orders.reduce((s, o) => s + (o.total || 0), 0);
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const monthRevenue = orders
    .filter(o => new Date(o.createdAt).getTime() >= startOfMonth)
    .reduce((s, o) => s + (o.total || 0), 0);
  return res.json({
    orders,
    stats: {
      totalOrders: orders.length,
      totalRevenue,
      monthRevenue,
      newCodes: orders.filter(o => o.type === 'new').length,
      topUps: orders.filter(o => o.type === 'topup').length,
    }
  });
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

// ── Lemon Squeezy Checkout ────────────────────────────────────────────────────
const LS_VARIANT_MAP = { '5': process.env.LS_VARIANT_5, '10': process.env.LS_VARIANT_10, '20': process.env.LS_VARIANT_20 };

app.post('/api/create-checkout', async (req, res) => {
  const { activationCode, plan } = req.body;
  const code = (activationCode || '').trim().toUpperCase();
  const variantId = LS_VARIANT_MAP[plan];

  if (!code || !plan) return res.status(400).json({ error: 'Missing code or plan' });
  if (!variantId) return res.status(400).json({ error: 'Invalid plan' });
  if (!process.env.LS_API_KEY) return res.status(503).json({ error: 'Payments not configured' });

  const exists = await codeExists(code);
  if (!exists) return res.status(403).json({ error: 'Code not found' });

  const FRONTEND = 'https://fuelplan.fit';

  try {
    const response = await axios.post('https://api.lemonsqueezy.com/v1/checkouts', {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: {
            custom: { activation_code: code }
          },
          product_options: {
            redirect_url: `${FRONTEND}/?payment=success`,
            enabled_variants: [parseInt(variantId)],
          },
          checkout_options: {
            button_color: '#c8f542',
          },
        },
        relationships: {
          store:   { data: { type: 'stores',   id: process.env.LS_STORE_ID } },
          variant: { data: { type: 'variants', id: variantId } },
        },
      },
    }, {
      headers: {
        Authorization: `Bearer ${process.env.LS_API_KEY}`,
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
      },
    });

    const url = response.data?.data?.attributes?.url;
    if (!url) throw new Error('No checkout URL returned');
    res.json({ url });
  } catch (err) {
    console.error('LS checkout error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

async function decrementRemaining(code) {
  await redisCommand('DECR', 'fuelplan:remaining:' + code);
}

async function getHistory(code) {
  const raw = await redisCommand('GET', 'fuelplan:history:' + code);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveOrderRecord(order) {
  const raw = await redisCommand('GET', 'fuelplan:orders');
  let orders = [];
  try { orders = raw ? JSON.parse(raw) : []; } catch { orders = []; }
  orders.unshift(order);
  if (orders.length > 1000) orders = orders.slice(0, 1000);
  await redisCommand('SET', 'fuelplan:orders', JSON.stringify(orders));
}

async function getAllOrders() {
  const raw = await redisCommand('GET', 'fuelplan:orders');
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

async function saveToHistory(code, entry) {
  let history = await getHistory(code);
  history.unshift(entry);
  if (history.length > MAX_HISTORY) {
    // Auto-archive overflow instead of hard deleting
    const overflow = history.slice(MAX_HISTORY);
    history = history.slice(0, MAX_HISTORY);
    try {
      const archiveRaw = await redisCommand('GET', 'fuelplan:archive:' + code);
      let archive = archiveRaw ? JSON.parse(archiveRaw) : [];
      // Store only metadata in archive (no full plan JSON — save Redis space)
      overflow.forEach(e => archive.unshift({ id: e.id, savedAt: e.savedAt, userName: e.userName, planName: e.planName, macros: e.macros }));
      archive = archive.slice(0, 50); // keep up to 50 archived plan records
      await redisCommand('SET', 'fuelplan:archive:' + code, JSON.stringify(archive));
    } catch (e) { /* non-critical */ }
  }
  await redisCommand('SET', 'fuelplan:history:' + code, JSON.stringify(history));
}

// ── Weekly summary push notifications ─────────────────────────────────────────
async function sendWeeklySummaryNotifications() {
  if (!VAPID_PRIVATE_KEY) return;
  console.log('[Weekly] Sending weekly summary push notifications…');
  try {
    const codes = await getAllCodes();
    let totalSent = 0;
    for (const code of codes) {
      const subs = await getPushSubscriptions(code);
      if (!subs.length) continue;
      const tracking = await getTrackingData(code);
      const weights = (tracking.weights || []).slice(0, 7);
      const latestWeight = weights[0] ? weights[0].displayVal : null;
      const payload = JSON.stringify({
        title: 'Fuelplan Weekly',
        body: latestWeight
          ? 'New week, new goals! Current weight: ' + latestWeight + '. Open your plan to get started.'
          : 'New week, new goals! Open Fuelplan to prep your meals.',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: 'fuelplan-weekly',
        url: '/'
      });
      const stale = [];
      await Promise.all(subs.map(async sub => {
        try { await webPush.sendNotification(sub, payload); totalSent++; }
        catch (e) { if (e.statusCode === 410 || e.statusCode === 404) stale.push(sub.endpoint); }
      }));
      if (stale.length) {
        const fresh = subs.filter(s => !stale.includes(s.endpoint));
        await redisCommand('SET', 'fuelplan:push:' + code, JSON.stringify(fresh));
      }
    }
    console.log('[Weekly] Sent ' + totalSent + ' notifications');
  } catch (e) {
    console.error('[Weekly] Error:', e.message);
  }
}

// Admin trigger for weekly summary
app.post('/api/admin/send-weekly', requireAdmin, async (req, res) => {
  await sendWeeklySummaryNotifications();
  res.json({ ok: true });
});

// Sunday 8pm UTC cron-style check (runs every hour, fires once on Sunday 20:xx)
const _weeklySentKey = 'fuelplan:weeklySentWeek';
setInterval(async function() {
  const now = new Date();
  if (now.getUTCDay() !== 0 || now.getUTCHours() !== 20) return; // Sunday 8pm UTC only
  try {
    // Check we haven't sent this week already
    const weekNum = Math.floor(Date.now() / (7 * 24 * 3600 * 1000));
    const lastSent = await redisCommand('GET', _weeklySentKey);
    if (lastSent && parseInt(lastSent) === weekNum) return;
    await redisCommand('SET', _weeklySentKey, String(weekNum));
    await sendWeeklySummaryNotifications();
  } catch (e) {
    console.error('[Weekly cron]', e.message);
  }
}, 3600000); // check every hour

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Fuelplan backend running on port ${PORT}`);
});
