require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

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
    // Hard cap on message length — legitimate meal plan requests don't need more than 3000 chars
    if (msg.content.length > 3000) {
      console.warn('Message content truncated — exceeded 3000 chars');
      msg.content = msg.content.slice(0, 3000);
    }
    return msg;
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getValidCodes() {
  return (process.env.ACTIVATION_CODES || '')
    .split(',')
    .map(c => c.trim().toUpperCase())
    .filter(Boolean);
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
  const { activationCode, ...payload } = req.body;

  // 1. Validate code
  if (!activationCode) return res.status(401).json({ error: 'No activation code provided' });
  if (!validateCode(activationCode)) return res.status(403).json({ error: 'Invalid activation code' });

  const code = activationCode.trim().toUpperCase();

  // 2. Check remaining plans (stored as remaining count, not used count)
  const remaining = await getRemaining(code);

  // null means key doesn't exist yet — initialize with default limit
  if (remaining === null) {
    await setRemaining(code, process.env.DEFAULT_PLAN_LIMIT ? parseInt(process.env.DEFAULT_PLAN_LIMIT) : 10);
  } else if (remaining <= 0) {
    return res.status(402).json({
      error: 'Plan limit reached',
      message: 'You have used all your meal plans. Contact us to top up your code.',
      remaining: 0
    });
  }

  // 3. Sanitize messages before forwarding
  if (payload.messages) {
    payload.messages = sanitizeUserContent(payload.messages);
  }

  // 4. Forward to Anthropic FIRST — only decrement on success
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

    // 4. Decrement ONLY after Anthropic succeeds
    await decrementRemaining(code);

    return res.status(response.status).json(response.data);

  } catch (err) {
    // Don't decrement — plan wasn't generated
    const status = err.response?.status || 502;
    const message = err.response?.data?.error?.message || err.message;
    return res.status(status).json({ error: message });
  }
});

// Usage check endpoint — returns remaining count
app.post('/api/usage', async (req, res) => {
  const { activationCode } = req.body;
  if (!activationCode) return res.status(400).json({ error: 'No code' });
  if (!validateCode(activationCode)) return res.status(403).json({ error: 'Invalid code' });

  const code = activationCode.trim().toUpperCase();
  let remaining = await getRemaining(code);

  // If key doesn't exist yet, show default limit
  if (remaining === null) {
    const limit = process.env.DEFAULT_PLAN_LIMIT ? parseInt(process.env.DEFAULT_PLAN_LIMIT) : 10;
    remaining = limit;
  }

  return res.json({ remaining, limit: remaining });
});

// ── Redis helpers (stores REMAINING count, not used count) ────────────────────
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
