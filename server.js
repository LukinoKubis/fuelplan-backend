require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_HISTORY = 5; // plans to keep per code

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '4mb' })); // larger limit to store plans

// CORS
app.use((req, res, next) => {
  const allowed = [
    (process.env.FRONTEND_URL || '').replace(/\/$/, ''),
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
  ].filter(Boolean);

  const origin = req.headers.origin;
  if (!origin || allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  } else {
    res.setHeader('Access-Control-Allow-Origin', allowed[0]);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function getValidCodes() {
  return (process.env.ACTIVATION_CODES || '')
    .split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
}

function validateCode(code) {
  if (!code) return false;
  return getValidCodes().includes(code.trim().toUpperCase());
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'fuelplan-backend' });
});

// Main Claude proxy
app.post('/api/claude', async (req, res) => {
  const { activationCode, planMeta, ...payload } = req.body;

  if (!activationCode) return res.status(401).json({ error: 'No activation code provided' });
  if (!validateCode(activationCode)) return res.status(403).json({ error: 'Invalid activation code' });

  const code = activationCode.trim().toUpperCase();

  const remaining = await getRemaining(code);
  if (remaining === null) {
    await setRemaining(code, process.env.DEFAULT_PLAN_LIMIT ? parseInt(process.env.DEFAULT_PLAN_LIMIT) : 10);
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

    // Decrement only on success
    await decrementRemaining(code);

    // Save to history if plan data is passed alongside
    if (planMeta) {
      await saveToHistory(code, planMeta);
    }

    return res.status(response.status).json(response.data);

  } catch (err) {
    const status = err.response?.status || 502;
    const message = err.response?.data?.error?.message || err.message;
    return res.status(status).json({ error: message });
  }
});

// Save plan to history (called from frontend after successful parse)
app.post('/api/history/save', async (req, res) => {
  const { activationCode, plan, userName, macros } = req.body;
  if (!activationCode) return res.status(401).json({ error: 'No code' });
  if (!validateCode(activationCode)) return res.status(403).json({ error: 'Invalid code' });
  if (!plan) return res.status(400).json({ error: 'No plan data' });

  const code = activationCode.trim().toUpperCase();
  const entry = {
    id: Date.now(),
    savedAt: new Date().toISOString(),
    userName: userName || 'User',
    macros: macros || plan.summary,
    plan
  };

  try {
    await saveToHistory(code, entry);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Get plan history
app.post('/api/history/get', async (req, res) => {
  const { activationCode } = req.body;
  if (!activationCode) return res.status(401).json({ error: 'No code' });
  if (!validateCode(activationCode)) return res.status(403).json({ error: 'Invalid code' });

  const code = activationCode.trim().toUpperCase();
  try {
    const history = await getHistory(code);
    // Return list with metadata only (no full plan) for the list view
    const list = history.map(entry => ({
      id: entry.id,
      savedAt: entry.savedAt,
      userName: entry.userName,
      macros: entry.macros
    }));
    return res.json({ history: list });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Get a specific plan from history by id
app.post('/api/history/restore', async (req, res) => {
  const { activationCode, planId } = req.body;
  if (!activationCode) return res.status(401).json({ error: 'No code' });
  if (!validateCode(activationCode)) return res.status(403).json({ error: 'Invalid code' });
  if (!planId) return res.status(400).json({ error: 'No planId' });

  const code = activationCode.trim().toUpperCase();
  try {
    const history = await getHistory(code);
    const entry = history.find(e => e.id === planId);
    if (!entry) return res.status(404).json({ error: 'Plan not found in history' });
    return res.json({ plan: entry.plan, userName: entry.userName, savedAt: entry.savedAt });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Usage check
app.post('/api/usage', async (req, res) => {
  const { activationCode } = req.body;
  if (!activationCode) return res.status(400).json({ error: 'No code' });
  if (!validateCode(activationCode)) return res.status(403).json({ error: 'Invalid code' });

  const code = activationCode.trim().toUpperCase();
  let remaining = await getRemaining(code);
  if (remaining === null) {
    const limit = process.env.DEFAULT_PLAN_LIMIT ? parseInt(process.env.DEFAULT_PLAN_LIMIT) : 10;
    remaining = limit;
  }
  return res.json({ remaining, limit: remaining });
});

// ── History helpers ───────────────────────────────────────────────────────────
async function getHistory(code) {
  const raw = await redisCommand('GET', 'fuelplan:history:' + code);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveToHistory(code, entry) {
  let history = await getHistory(code);
  // Prepend new entry (newest first)
  history.unshift(entry);
  // Keep only MAX_HISTORY entries
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
  await redisCommand('SET', 'fuelplan:history:' + code, JSON.stringify(history));
}

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

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Fuelplan backend running on port ${PORT}`);
});
