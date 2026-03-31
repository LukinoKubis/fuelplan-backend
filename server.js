require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

// CORS — allow your Netlify frontend (and localhost for testing)
app.use((req, res, next) => {
  const allowed = [
    (process.env.FRONTEND_URL || '').replace(/\/$/, ''), // strip trailing slash
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

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'fuelplan-backend' });
});

// Main Claude proxy — plan generation & cost estimates
app.post('/api/claude', async (req, res) => {
  const { activationCode, isCostEstimate, ...payload } = req.body;

  // 1. Validate activation code
  if (!activationCode) {
    return res.status(401).json({ error: 'No activation code provided' });
  }
  if (!validateCode(activationCode)) {
    return res.status(403).json({ error: 'Invalid activation code' });
  }

  // 2. Check usage limit (plan generation only, not cost estimates)
  const MAX_PLANS = 10;
  const code = activationCode.trim().toUpperCase();

  if (!isCostEstimate) {
    const used = await getUsage(code);
    if (used >= MAX_PLANS) {
      return res.status(402).json({
        error: 'Plan limit reached',
        message: `You have used all ${MAX_PLANS} meal plans included with your code. Contact us to get a new code.`,
        used,
        limit: MAX_PLANS
      });
    }
    await incrementUsage(code);
  }

  // 3. Forward to Anthropic — no timeout worries on Railway
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
        timeout: 120000 // 2 minutes — Railway has no hard limit
      }
    );
    return res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const message = err.response?.data?.error?.message || err.message;
    return res.status(status).json({ error: message });
  }
});

// Usage check endpoint
app.post('/api/usage', async (req, res) => {
  const { activationCode } = req.body;
  if (!activationCode) return res.status(400).json({ error: 'No code' });
  if (!validateCode(activationCode)) return res.status(403).json({ error: 'Invalid code' });

  const code = activationCode.trim().toUpperCase();
  const used = await getUsage(code);
  const remaining = Math.max(0, 10 - used);
  return res.json({ used, remaining, limit: 10 });
});

// ── Usage tracking (Upstash Redis via REST) ───────────────────────────────────
async function redisCommand(command, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  // If Redis isn't configured, skip tracking silently
  if (!url || !token) return null;

  try {
    const response = await axios.post(
      url,
      [command, ...args],
      {
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );
    return response.data.result;
  } catch (err) {
    console.error('Redis error:', err.message);
    return null;
  }
}

async function getUsage(code) {
  const result = await redisCommand('GET', 'fuelplan:usage:' + code);
  return result === null || result === undefined ? 0 : parseInt(result, 10);
}

async function incrementUsage(code) {
  await redisCommand('INCR', 'fuelplan:usage:' + code);
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Fuelplan backend running on port ${PORT}`);
});
