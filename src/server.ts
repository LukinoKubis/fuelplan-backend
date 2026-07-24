import './polyfills.js'
import 'dotenv/config'
import express, { type Request, type Response, type NextFunction } from 'express'
import axios from 'axios'
import path from 'path'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { Expo, type ExpoPushMessage, type ExpoPushToken } from 'expo-server-sdk'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3000
const MAX_HISTORY = 5
// Unlike history, recipes are user-curated (not auto-generated), so
// overflow returns a 400 instead of silently evicting/archiving the
// oldest one — losing something a user deliberately saved is worse than
// losing an old auto-generated plan.
const MAX_RECIPES = 300
const JWT_SECRET = process.env.JWT_SECRET || ''
const JWT_EXPIRY = '90d'

// ── Shared types ──────────────────────────────────────────────────────────
interface Macros {
  kcal?: number
  protein?: number
  carbs?: number
  fat?: number
  [key: string]: unknown
}

interface HistoryEntry {
  id: number
  savedAt: string
  userName: string
  planName: string
  macros: Macros
  plan: unknown
}

interface ArchiveEntry {
  id: number
  savedAt: string
  userName: string
  planName: string
  macros: Macros
}

/** One saved recipe in a user's personal recipe box — imported via the app or saved manually. */
interface RecipeRecord {
  id: number
  name: string
  ingredients: { name: string; qty: string }[]
  steps: string[]
  macros: Macros
  servings?: number
  sourceUrl?: string
  sourceCaption?: string
  sourcePlatform?: 'instagram' | 'tiktok' | 'manual' | 'other'
  savedAt: string
  updatedAt?: string
}

interface OrderRecord {
  id: string
  userId: string
  email: string
  credits: number
  variantId: string
  total: number
  subtotal: number
  tax: number
  currency: string
  createdAt: string
  type: 'new' | 'topup' | null
}

// Just the Expo push token string now (e.g. "ExponentPushToken[xxxx]"),
// not a full browser PushSubscription object — native push tokens are
// already opaque, self-contained identifiers.

interface TrackingData {
  calendarLog?: Record<string, unknown>
  weights?: { date: string; [key: string]: unknown }[]
  dayNotes?: Record<string, unknown>
  waterGoal?: number
  updatedAt?: string
  [key: string]: unknown
}

interface UserRecord {
  id: string
  email: string
  passwordHash: string
  createdAt: string
}

// ── Expo Push setup ───────────────────────────────────────────────────────────
// EXPO_ACCESS_TOKEN is optional (only needed for enhanced push security —
// see https://docs.expo.dev/push-notifications/sending-notifications/#additional-security)
// but Android delivery requires FCM v1 credentials to be uploaded to EAS
// separately (`eas credentials`) — that's project-level config, not
// something this backend reads directly.
const expo = new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN })

// ── Simple in-memory rate limiter ────────────────────────────────────────────
const _rateLimitMap = new Map<string, { count: number; resetAt: number }>()
function rateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now()
  const entry = _rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs }
  if (now > entry.resetAt) {
    entry.count = 0
    entry.resetAt = now + windowMs
  }
  entry.count++
  _rateLimitMap.set(key, entry)
  return entry.count <= maxRequests
}
// Clean up old entries every 10 minutes
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of _rateLimitMap) {
    if (now > v.resetAt) _rateLimitMap.delete(k)
  }
}, 600000)

// ── Lemon Squeezy credit map (variant ID → credits) ──────────────────────────
const LS_PLANS: Record<string, number> = {
  [process.env.LS_VARIANT_5 || '']: 5,
  [process.env.LS_VARIANT_10 || '']: 10,
  [process.env.LS_VARIANT_20 || '']: 20,
}

// ── Middleware ────────────────────────────────────────────────────────────────
// LS webhook needs raw body for signature check — must come BEFORE express.json()
app.post('/api/webhook/lemonsqueezy', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const secret = process.env.LS_WEBHOOK_SECRET
  const signature = req.headers['x-signature'] as string | undefined

  if (!secret || !signature) {
    console.error('LS webhook: missing secret or signature')
    return res.status(400).send('Missing signature')
  }

  const body = req.body as Buffer
  const hmac = crypto.createHmac('sha256', secret).update(body).digest('hex')
  if (hmac !== signature) {
    console.error('LS webhook: signature mismatch')
    return res.status(400).send('Signature mismatch')
  }

  let payload: any
  try {
    payload = JSON.parse(body.toString())
  } catch {
    return res.status(400).send('Invalid JSON')
  }

  const eventName = payload.meta?.event_name
  if (eventName !== 'order_created') return res.json({ received: true })

  const order = payload.data?.attributes
  if (!order || order.status !== 'paid') return res.json({ received: true })

  const userId = payload.meta?.custom_data?.user_id || ''
  const variantId = String(payload.data?.attributes?.first_order_item?.variant_id || '')
  const credits = LS_PLANS[variantId]

  if (!userId || !credits) {
    console.error('LS webhook: missing user_id or unrecognised variant', { userId, variantId })
    return res.json({ received: true })
  }

  const user = await getUserById(userId)
  if (!user) {
    console.error('LS webhook: unknown user_id', userId)
    return res.json({ received: true })
  }

  const orderAttr = payload.data?.attributes || {}
  const orderRecord: OrderRecord = {
    id: payload.data?.id || '',
    userId,
    email: user.email,
    credits,
    variantId,
    total: orderAttr.total || 0,
    subtotal: orderAttr.subtotal || 0,
    tax: orderAttr.tax || 0,
    currency: (orderAttr.currency || 'EUR').toUpperCase(),
    createdAt: orderAttr.created_at || new Date().toISOString(),
    type: null,
  }

  try {
    const remaining = await getRemaining(userId)
    orderRecord.type = remaining !== null ? 'topup' : 'new'
    await redisCommand('INCRBY', 'fuelplan:remaining:' + userId, credits)
    console.log(`LS: credited ${user.email} (${userId}) with ${credits} credits`)
    await saveOrderRecord(orderRecord)
  } catch (err) {
    console.error('Redis error in LS webhook:', err)
    return res.status(500).json({ error: 'Redis error' })
  }

  res.json({ received: true })
})

app.use(express.json({ limit: '4mb' }))

// CORS
app.use((req: Request, res: Response, next: NextFunction) => {
  const allowed = [
    (process.env.FRONTEND_URL || '').replace(/\/$/, ''),
    'https://fuelplan.fit',
    'https://www.fuelplan.fit',
    'https://fuelplan.netlify.app',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:5173',
  ].filter(Boolean)

  const origin = req.headers.origin

  // Allow if no origin (direct API calls, mobile apps) or origin is in allowlist
  if (!origin || allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*')
  } else {
    // Still allow — don't block unknown origins, just don't echo them
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

// ── Input sanitization ────────────────────────────────────────────────────────
interface ClaudeMessage {
  role: string
  content: unknown
}

function sanitizeUserContent(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages
  return messages.map((msg: ClaudeMessage) => {
    if (typeof msg.content !== 'string') return msg
    if (msg.content.length > 3000) {
      console.warn('Message content truncated')
      msg.content = msg.content.slice(0, 3000)
    }
    return msg
  })
}

// ── Admin middleware ──────────────────────────────────────────────────────────
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const key = (req.headers['x-admin-key'] as string | undefined) || req.body?.adminKey
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

// ── Auth middleware ───────────────────────────────────────────────────────────
interface AuthedRequest extends Request {
  userId?: string
  userEmail?: string
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
  if (!token || !JWT_SECRET) return res.status(401).json({ error: 'Not authenticated' })
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string; email: string }
    req.userId = payload.userId
    req.userEmail = payload.email
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' })
  }
}

// ── Serve admin dashboard ─────────────────────────────────────────────────────
app.get('/admin', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'admin.html'))
})

app.get('/', (req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'fuelplan-backend' })
})

// ── Redis: user registry (stored as a Redis Set of userIds) ──────────────────
async function getAllUserIds(): Promise<string[]> {
  const result = await redisCommand('SMEMBERS', 'fuelplan:users')
  return Array.isArray(result) ? result : []
}

async function getUserById(userId: string): Promise<UserRecord | null> {
  const raw = await redisCommand('GET', 'fuelplan:user:' + userId)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function getUserIdByEmail(email: string): Promise<string | null> {
  return redisCommand('GET', 'fuelplan:user:email:' + email)
}

async function saveUser(user: UserRecord): Promise<void> {
  await redisCommand('SET', 'fuelplan:user:' + user.id, JSON.stringify(user))
}

// ── Auth endpoints ────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

app.post('/api/auth/signup', async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string }
  const emailClean = (email || '').trim().toLowerCase()
  if (!emailClean || !EMAIL_RE.test(emailClean)) return res.status(400).json({ error: 'Enter a valid email address' })
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })
  if (!JWT_SECRET) return res.status(503).json({ error: 'Auth not configured' })
  if (!rateLimit('signup:' + emailClean, 5, 3600000)) return res.status(429).json({ error: 'Too many attempts — try again later' })

  try {
    const existing = await getUserIdByEmail(emailClean)
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' })

    const userId = crypto.randomUUID()
    const passwordHash = await bcrypt.hash(password, 10)
    const user: UserRecord = { id: userId, email: emailClean, passwordHash, createdAt: new Date().toISOString() }

    await saveUser(user)
    await redisCommand('SET', 'fuelplan:user:email:' + emailClean, userId)
    await redisCommand('SADD', 'fuelplan:users', userId)

    const token = jwt.sign({ userId, email: emailClean }, JWT_SECRET, { expiresIn: JWT_EXPIRY })
    return res.json({ token, email: emailClean })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/auth/login', async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string }
  const emailClean = (email || '').trim().toLowerCase()
  if (!emailClean || !password) return res.status(400).json({ error: 'Email and password required' })
  if (!JWT_SECRET) return res.status(503).json({ error: 'Auth not configured' })
  if (!rateLimit('login:' + emailClean, 10, 900000)) return res.status(429).json({ error: 'Too many attempts — try again later' })

  try {
    const userId = await getUserIdByEmail(emailClean)
    if (!userId) return res.status(401).json({ error: 'Invalid email or password' })
    const user = await getUserById(userId)
    if (!user) return res.status(401).json({ error: 'Invalid email or password' })
    const ok = await bcrypt.compare(password, user.passwordHash)
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' })

    const token = jwt.sign({ userId, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRY })
    return res.json({ token, email: user.email })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

app.get('/api/auth/me', requireAuth, async (req: AuthedRequest, res: Response) => {
  return res.json({ email: req.userEmail })
})

app.post('/api/auth/forgot-password', async (req: Request, res: Response) => {
  const { email } = req.body as { email?: string }
  const emailClean = (email || '').trim().toLowerCase()
  if (!emailClean) return res.status(400).json({ error: 'Email required' })
  if (!rateLimit('forgot:' + emailClean, 3, 3600000)) return res.json({ ok: true }) // don't leak rate-limit state either

  try {
    const userId = await getUserIdByEmail(emailClean)
    if (userId && process.env.RESEND_API_KEY) {
      const token = crypto.randomBytes(32).toString('hex')
      await redisCommand('SET', 'fuelplan:resetToken:' + token, userId, 'EX', 3600)
      await axios.post(
        'https://api.resend.com/emails',
        {
          from: process.env.FROM_EMAIL || 'Fuelplan <noreply@fuelplan.fit>',
          to: [emailClean],
          subject: 'Reset your Fuelplan password',
          html:
            '<p>Hi — someone requested a password reset for your Fuelplan account.</p>' +
            `<p><a href="https://fuelplan.fit/?reset=${token}">Click here to set a new password</a> (link expires in 1 hour).</p>` +
            '<p>If you didn’t request this, you can ignore this email.</p>' +
            '<p>— The Fuelplan team</p>',
        },
        { headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' } }
      )
    }
  } catch (err) {
    console.error('Forgot-password email error:', (err as Error).message)
  }
  // Always return ok — don't leak whether the email exists
  return res.json({ ok: true })
})

app.post('/api/auth/reset-password', async (req: Request, res: Response) => {
  const { token, newPassword } = req.body as { token?: string; newPassword?: string }
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' })
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })

  try {
    const userId = await redisCommand('GET', 'fuelplan:resetToken:' + token)
    if (!userId) return res.status(400).json({ error: 'Reset link is invalid or has expired' })
    const user = await getUserById(userId)
    if (!user) return res.status(400).json({ error: 'Reset link is invalid or has expired' })

    user.passwordHash = await bcrypt.hash(newPassword, 10)
    await saveUser(user)
    await redisCommand('DEL', 'fuelplan:resetToken:' + token)
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

// ── Main Claude proxy ─────────────────────────────────────────────────────────
interface ClaudeProxyBody {
  planMeta?: HistoryEntry
  messages?: ClaudeMessage[]
  [key: string]: unknown
}

app.post('/api/claude', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!
  const { planMeta, ...payload } = req.body as ClaudeProxyBody

  const remaining = await getRemaining(userId)

  if (remaining === null) {
    // First use — set default, fire and forget (don't block the request)
    setRemaining(userId, parseInt(process.env.DEFAULT_PLAN_LIMIT || '') || 10).catch(() => {})
  } else if (remaining <= 0) {
    return res.status(402).json({
      error: 'Plan limit reached',
      message: 'You have used all your meal plans. Top up in Settings to keep generating.',
      remaining: 0,
    })
  }

  if (payload.messages) payload.messages = sanitizeUserContent(payload.messages) as ClaudeMessage[]

  try {
    const response = await axios.post('https://api.anthropic.com/v1/messages', payload, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      timeout: 120000,
    })

    // Fire Redis writes in parallel after Anthropic responds — client doesn't wait for these
    const writes: Promise<unknown>[] = [decrementRemaining(userId)]
    if (planMeta) writes.push(saveToHistory(userId, planMeta))
    Promise.all(writes).catch((err) => console.error('Post-write error:', err.message))

    return res.status(response.status).json(response.data)
  } catch (err) {
    const anthropicMsg = (err as any).response?.data?.error?.message
    const isTimeout = (err as any).code === 'ECONNABORTED' || (err as Error).message.includes('timeout')
    if (isTimeout) return res.status(504).json({ error: 'Request timed out — please try again.' })
    if ((err as any).response?.status === 529 || (err as any).response?.status === 503) {
      return res.status(503).json({ error: 'The AI service is temporarily overloaded — please try again in a moment.' })
    }
    return res.status(500).json({ error: anthropicMsg || 'AI service error — please try again.' })
  }
})

// ── History endpoints ─────────────────────────────────────────────────────────
interface HistorySaveBody {
  plan?: { summary?: Macros; [key: string]: unknown }
  userName?: string
  planName?: string
  macros?: Macros
}

app.post('/api/history/save', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!
  const { plan, userName, planName, macros } = req.body as HistorySaveBody
  if (!plan) return res.status(400).json({ error: 'No plan data' })

  const entry: HistoryEntry = {
    id: Date.now(),
    savedAt: new Date().toISOString(),
    userName: userName || 'User',
    planName: planName || 'My Plan',
    macros: macros || plan.summary || {},
    plan,
  }

  try {
    await saveToHistory(userId, entry)
    return res.json({ ok: true, id: entry.id })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/history/get', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!
  try {
    const history = await getHistory(userId)
    return res.json({
      history: history.map((e) => ({ id: e.id, savedAt: e.savedAt, userName: e.userName, planName: e.planName, macros: e.macros })),
    })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/history/restore', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!
  const { planId } = req.body as { planId?: number }
  if (!planId) return res.status(400).json({ error: 'No planId' })

  try {
    const history = await getHistory(userId)
    const entry = history.find((e) => e.id === planId)
    if (!entry) return res.status(404).json({ error: 'Plan not found' })
    return res.json({ plan: entry.plan, userName: entry.userName, planName: entry.planName, savedAt: entry.savedAt })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

// ── Delete a plan from history ────────────────────────────────────────────────
app.post('/api/history/delete', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!
  const { planId } = req.body as { planId?: number }
  if (!planId) return res.status(400).json({ error: 'No planId' })

  try {
    let history = await getHistory(userId)
    const before = history.length
    history = history.filter((e) => e.id !== planId)
    if (history.length === before) return res.status(404).json({ error: 'Plan not found' })
    await redisCommand('SET', 'fuelplan:history:' + userId, JSON.stringify(history))
    return res.json({ ok: true, remaining: history.length })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

// ── View archived plans (metadata only) ──────────────────────────────────────
app.post('/api/history/archive', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!
  try {
    const raw = await redisCommand('GET', 'fuelplan:archive:' + userId)
    const archive: ArchiveEntry[] = raw ? JSON.parse(raw) : []
    return res.json({ archive })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

// ── Recipe box endpoints ───────────────────────────────────────────────────────
// Save (or update, if `recipe.id` matches an existing entry) a recipe.
app.post('/api/recipes/save', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!
  const { recipe } = req.body as { recipe?: Partial<RecipeRecord> }
  if (!recipe || !recipe.name) return res.status(400).json({ error: 'No recipe data' })

  const record: RecipeRecord = {
    id: recipe.id ?? 0,
    name: recipe.name,
    ingredients: recipe.ingredients || [],
    steps: recipe.steps || [],
    macros: recipe.macros || {},
    servings: recipe.servings,
    sourceUrl: recipe.sourceUrl,
    sourceCaption: recipe.sourceCaption,
    sourcePlatform: recipe.sourcePlatform,
    savedAt: recipe.savedAt || new Date().toISOString(),
  }

  try {
    const saved = await saveRecipeRecord(userId, record)
    return res.json({ ok: true, recipe: saved })
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message })
  }
})

// Lists all of the signed-in user's saved recipes.
app.post('/api/recipes/list', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!
  try {
    const recipes = await getRecipes(userId)
    return res.json({ recipes })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

// Removes a recipe from the user's box.
app.post('/api/recipes/delete', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!
  const { recipeId } = req.body as { recipeId?: number }
  if (!recipeId) return res.status(400).json({ error: 'No recipeId' })

  try {
    let recipes = await getRecipes(userId)
    const before = recipes.length
    recipes = recipes.filter((r) => r.id !== recipeId)
    if (recipes.length === before) return res.status(404).json({ error: 'Recipe not found' })
    await redisCommand('SET', 'fuelplan:recipes:' + userId, JSON.stringify(recipes))
    return res.json({ ok: true, remaining: recipes.length })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

// ── User tracking data (calendar, weights, notes, water goal) ────────────────
app.post('/api/tracking/save', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!
  const { data } = req.body as { data?: TrackingData }
  if (!rateLimit('tracking:save:' + userId, 30, 60000)) return res.status(429).json({ error: 'Too many requests' })
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'No data' })

  try {
    const existing = await getTrackingData(userId)
    const merged = mergeTrackingData(existing, data)
    await redisCommand('SET', 'fuelplan:tracking:' + userId, JSON.stringify(merged))
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/tracking/get', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!
  if (!rateLimit('tracking:get:' + userId, 10, 60000)) return res.status(429).json({ error: 'Too many requests' })

  try {
    const data = await getTrackingData(userId)
    return res.json({ data })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

async function getTrackingData(userId: string): Promise<TrackingData> {
  const raw = await redisCommand('GET', 'fuelplan:tracking:' + userId)
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function mergeTrackingData(existing: TrackingData, incoming: TrackingData): TrackingData {
  const merged: TrackingData = { ...existing }

  // calendarLog: union all date keys — incoming overwrites existing for same date
  if (incoming.calendarLog && typeof incoming.calendarLog === 'object') {
    merged.calendarLog = { ...(existing.calendarLog || {}), ...incoming.calendarLog }
  }

  // weights: merge by date — local (incoming) wins on conflict
  if (Array.isArray(incoming.weights)) {
    const existingByDate: Record<string, { date: string; [key: string]: unknown }> = {}
    ;(existing.weights || []).forEach((w) => {
      existingByDate[w.date] = w
    })
    incoming.weights.forEach((w) => {
      existingByDate[w.date] = w
    }) // incoming overwrites
    merged.weights = Object.values(existingByDate)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 365)
  }

  // dayNotes: union — incoming overwrites existing for same key
  if (incoming.dayNotes && typeof incoming.dayNotes === 'object') {
    merged.dayNotes = { ...(existing.dayNotes || {}), ...incoming.dayNotes }
  }

  // waterGoal: incoming wins
  if (typeof incoming.waterGoal === 'number') {
    merged.waterGoal = incoming.waterGoal
  }

  merged.updatedAt = new Date().toISOString()
  return merged
}

// ── Data export — dumps all user data as JSON ─────────────────────────────────
app.post('/api/export', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!
  try {
    const [trackingRaw, historyRaw] = await Promise.all([
      redisCommand('GET', 'fuelplan:tracking:' + userId),
      redisCommand('GET', 'fuelplan:history:' + userId),
    ])
    const tracking = trackingRaw ? JSON.parse(trackingRaw) : {}
    const history = historyRaw ? JSON.parse(historyRaw) : []
    const remaining = await redisCommand('GET', 'fuelplan:remaining:' + userId)
    const exportData = {
      exportedAt: new Date().toISOString(),
      email: req.userEmail,
      plansRemaining: remaining !== null ? parseInt(remaining) : null,
      savedPlans: history,
      tracking,
    }
    res.setHeader('Content-Disposition', 'attachment; filename="fuelplan-export.json"')
    res.setHeader('Content-Type', 'application/json')
    return res.json(exportData)
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

// ── Expo Push endpoints ────────────────────────────────────────────────────────
// Save a push token for a user (registered client-side via
// expo-notifications' getExpoPushTokenAsync())
app.post('/api/push/subscribe', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!
  const { token } = req.body as { token?: string }
  if (!token || !Expo.isExpoPushToken(token)) return res.status(400).json({ error: 'Invalid or missing push token' })

  try {
    // Store token (up to 3 devices per user)
    const existing = await getPushTokens(userId)
    const filtered = existing.filter((t) => t !== token)
    filtered.unshift(token)
    await redisCommand('SET', 'fuelplan:push:' + userId, JSON.stringify(filtered.slice(0, 3)))
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

// Remove push token
app.post('/api/push/unsubscribe', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!
  const { token } = req.body as { token?: string }

  try {
    const existing = await getPushTokens(userId)
    const filtered = existing.filter((t) => t !== token)
    await redisCommand('SET', 'fuelplan:push:' + userId, JSON.stringify(filtered))
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

// Send a test push notification
app.post('/api/push/test', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!
  const tokens = await getPushTokens(userId)
  if (!tokens.length) return res.status(404).json({ error: 'No push tokens registered' })

  const { sent, stale } = await sendExpoPush(tokens, {
    title: 'Fuelplan 🌿',
    body: 'Push notifications are working! Check your plan.',
  })

  if (stale.length) {
    const fresh = tokens.filter((t) => !stale.includes(t))
    await redisCommand('SET', 'fuelplan:push:' + userId, JSON.stringify(fresh))
  }

  return res.json({ ok: true, sent, total: tokens.length })
})

async function getPushTokens(userId: string): Promise<string[]> {
  const raw = await redisCommand('GET', 'fuelplan:push:' + userId)
  if (!raw) return []
  try {
    return JSON.parse(raw)
  } catch {
    return []
  }
}

// Sends to every token, chunked per Expo's SDK requirement, and fetches
// delivery receipts to detect tokens that should be dropped (the
// DeviceNotRegistered equivalent of the old web-push 410/404 handling —
// Expo's send-time errors alone don't tell you this, only receipts do).
async function sendExpoPush(
  tokens: string[],
  { title, body }: { title: string; body: string }
): Promise<{ sent: number; stale: string[] }> {
  const valid = tokens.filter((t) => Expo.isExpoPushToken(t)) as ExpoPushToken[]
  if (!valid.length) return { sent: 0, stale: tokens.filter((t) => !Expo.isExpoPushToken(t)) }

  // Chunk tokens and messages together (not just messages) so a ticket can
  // always be traced back to the token that produced it — chunking
  // messages alone and relying on positional index alignment breaks the
  // moment any one chunk's send fails (tickets falls behind valid/token
  // order for every chunk after it).
  const tokenChunks: ExpoPushToken[][] = []
  const messageChunks: ExpoPushMessage[][] = []
  for (let i = 0; i < valid.length; i += 100) {
    tokenChunks.push(valid.slice(i, i + 100))
    messageChunks.push(valid.slice(i, i + 100).map((to) => ({ to, sound: 'default', title, body }) as ExpoPushMessage))
  }

  const receiptIdToToken = new Map<string, string>()
  for (let i = 0; i < messageChunks.length; i++) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(messageChunks[i])
      tickets.forEach((ticket, j) => {
        if (ticket.status === 'ok' && ticket.id) receiptIdToToken.set(ticket.id, tokenChunks[i][j])
      })
    } catch (e) {
      console.error('[push] chunk send failed:', (e as Error).message)
    }
  }

  const stale: string[] = []
  let sent = 0
  const receiptChunks = expo.chunkPushNotificationReceiptIds([...receiptIdToToken.keys()])
  for (const chunk of receiptChunks) {
    try {
      const receipts = await expo.getPushNotificationReceiptsAsync(chunk)
      for (const [receiptId, receipt] of Object.entries(receipts)) {
        if (receipt.status === 'ok') {
          sent++
        } else if (receipt.details?.error === 'DeviceNotRegistered') {
          const token = receiptIdToToken.get(receiptId)
          if (token) stale.push(token)
        }
      }
    } catch (e) {
      console.error('[push] receipt fetch failed:', (e as Error).message)
    }
  }

  return { sent, stale }
}

// ── Usage check ───────────────────────────────────────────────────────────────
app.post('/api/usage', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!
  let remaining = await getRemaining(userId)
  if (remaining === null) {
    remaining = parseInt(process.env.DEFAULT_PLAN_LIMIT || '') || 10
  }
  return res.json({ remaining })
})

// ── Admin: all users with stats ───────────────────────────────────────────────
app.post('/api/admin/users', requireAdmin, async (req: Request, res: Response) => {
  const userIds = await getAllUserIds()
  const results = await Promise.all(
    userIds.map(async (userId) => {
      const user = await getUserById(userId)
      const remaining = await getRemaining(userId)
      const history = await getHistory(userId)
      const note = (await redisCommand('GET', 'fuelplan:note:' + userId)) || ''
      const last = history[0] || null
      return {
        userId,
        email: user?.email || '(deleted)',
        remaining: remaining ?? 0,
        plansUsed: history.length,
        plansSaved: history.length,
        lastUsed: last ? last.savedAt : null,
        lastUser: last ? last.userName : null,
        lastPlanName: last ? last.planName : null,
        note,
        plans: history.map((h) => ({ id: h.id, planName: h.planName, savedAt: h.savedAt, userName: h.userName, macros: h.macros })),
      }
    })
  )
  results.sort((a, b) => a.email.localeCompare(b.email))
  return res.json({ users: results })
})

// ── Admin: stats overview ─────────────────────────────────────────────────────
app.post('/api/admin/stats', requireAdmin, async (req: Request, res: Response) => {
  const userIds = await getAllUserIds()
  let totalPlansGenerated = 0
  let activeUsers = 0
  let usersNearLimit = 0
  const activity: { email: string; savedAt: string; userName: string; planName: string; macros: Macros }[] = []

  await Promise.all(
    userIds.map(async (userId) => {
      const user = await getUserById(userId)
      const remaining = await getRemaining(userId)
      const history = await getHistory(userId)
      totalPlansGenerated += history.length
      if (history.length > 0) activeUsers++
      if (remaining !== null && remaining <= 2 && remaining > 0) usersNearLimit++
      history.forEach((h) => activity.push({ email: user?.email || '(deleted)', savedAt: h.savedAt, userName: h.userName, planName: h.planName, macros: h.macros }))
    })
  )

  activity.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime())

  return res.json({
    totalUsers: userIds.length,
    activeUsers,
    totalPlansGenerated,
    usersNearLimit,
    recentActivity: activity.slice(0, 10),
  })
})

// ── Admin: set remaining credits for a user (by email) ────────────────────────
app.post('/api/admin/set-remaining', requireAdmin, async (req: Request, res: Response) => {
  const { email, amount } = req.body as { email?: string; amount?: number | string }
  if (!email || amount === undefined) return res.status(400).json({ error: 'email and amount required' })
  const userId = await getUserIdByEmail(email.trim().toLowerCase())
  if (!userId) return res.status(404).json({ error: 'No user with that email' })
  await setRemaining(userId, parseInt(String(amount)))
  return res.json({ ok: true, email, remaining: parseInt(String(amount)) })
})

// ── Admin: revoke a user (zero credits, remove from registry) ────────────────
app.post('/api/admin/revoke-user', requireAdmin, async (req: Request, res: Response) => {
  const { email } = req.body as { email?: string }
  if (!email) return res.status(400).json({ error: 'email required' })
  const userId = await getUserIdByEmail(email.trim().toLowerCase())
  if (!userId) return res.status(404).json({ error: 'No user with that email' })
  await redisCommand('SREM', 'fuelplan:users', userId)
  await setRemaining(userId, 0)
  return res.json({ ok: true, email })
})

// ── Admin: history for a user (by email) ──────────────────────────────────────
app.post('/api/admin/history', requireAdmin, async (req: Request, res: Response) => {
  const { email } = req.body as { email?: string }
  if (!email) return res.status(400).json({ error: 'email required' })
  const userId = await getUserIdByEmail(email.trim().toLowerCase())
  if (!userId) return res.status(404).json({ error: 'No user with that email' })
  const history = await getHistory(userId)
  return res.json({ history })
})

// ── Suggestion proxy (meal swap, etc.) — validates auth but does NOT decrement ─
app.post('/api/claude/suggest', requireAuth, async (req: AuthedRequest, res: Response) => {
  const payload = req.body as ClaudeProxyBody
  // Cap tokens to prevent abuse
  if (typeof payload.max_tokens === 'number' && payload.max_tokens > 1200) payload.max_tokens = 1200
  if (payload.messages) payload.messages = sanitizeUserContent(payload.messages) as ClaudeMessage[]
  try {
    const response = await axios.post('https://api.anthropic.com/v1/messages', payload, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      timeout: 30000,
    })
    return res.status(response.status).json(response.data)
  } catch (err) {
    const isTimeout = (err as any).code === 'ECONNABORTED' || (err as Error).message.includes('timeout')
    if (isTimeout) return res.status(504).json({ error: 'Request timed out — please try again.' })
    return res.status(500).json({ error: 'AI service error — please try again.' })
  }
})

// ── Admin: set note for a user ─────────────────────────────────────────────────
app.post('/api/admin/set-note', requireAdmin, async (req: Request, res: Response) => {
  const { email, note } = req.body as { email?: string; note?: string }
  if (!email) return res.status(400).json({ error: 'email required' })
  const userId = await getUserIdByEmail(email.trim().toLowerCase())
  if (!userId) return res.status(404).json({ error: 'No user with that email' })
  await redisCommand('SET', 'fuelplan:note:' + userId, note || '')
  return res.json({ ok: true, email })
})

// ── Admin: orders ─────────────────────────────────────────────────────────────
app.post('/api/admin/orders', requireAdmin, async (req: Request, res: Response) => {
  const orders = await getAllOrders()
  const totalRevenue = orders.reduce((s, o) => s + (o.total || 0), 0)
  const now = new Date()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  const monthRevenue = orders.filter((o) => new Date(o.createdAt).getTime() >= startOfMonth).reduce((s, o) => s + (o.total || 0), 0)
  return res.json({
    orders,
    stats: {
      totalOrders: orders.length,
      totalRevenue,
      monthRevenue,
      newCodes: orders.filter((o) => o.type === 'new').length,
      topUps: orders.filter((o) => o.type === 'topup').length,
    },
  })
})

// ── Admin: health check ───────────────────────────────────────────────────────
app.get('/api/admin/health', requireAdmin, async (req: Request, res: Response) => {
  const t0 = Date.now()
  const result = await redisCommand('PING')
  const responseMs = Date.now() - t0
  const redisOk = result === 'PONG'
  return res.json({ redis: redisOk ? 'ok' : 'error', responseMs })
})

// ── Redis helpers ─────────────────────────────────────────────────────────────
async function redisCommand(command: string, ...args: (string | number)[]): Promise<any> {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null

  try {
    const response = await axios.post(url, [command, ...args], {
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      timeout: 5000,
    })
    return response.data.result
  } catch (err) {
    console.error('Redis error:', (err as Error).message)
    return null
  }
}

async function getRemaining(userId: string): Promise<number | null> {
  const result = await redisCommand('GET', 'fuelplan:remaining:' + userId)
  if (result === null || result === undefined) return null
  return parseInt(result, 10)
}

async function setRemaining(userId: string, count: number): Promise<void> {
  await redisCommand('SET', 'fuelplan:remaining:' + userId, count)
}

// ── Lemon Squeezy Checkout ────────────────────────────────────────────────────
const LS_VARIANT_MAP: Record<string, string | undefined> = {
  '5': process.env.LS_VARIANT_5,
  '10': process.env.LS_VARIANT_10,
  '20': process.env.LS_VARIANT_20,
}

app.post('/api/create-checkout', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!
  const { plan } = req.body as { plan?: string }
  const variantId = plan ? LS_VARIANT_MAP[plan] : undefined

  if (!plan) return res.status(400).json({ error: 'Missing plan' })
  if (!variantId) return res.status(400).json({ error: 'Invalid plan' })
  if (!process.env.LS_API_KEY) return res.status(503).json({ error: 'Payments not configured' })

  const FRONTEND = 'https://fuelplan.fit'

  try {
    const response = await axios.post(
      'https://api.lemonsqueezy.com/v1/checkouts',
      {
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: {
              custom: { user_id: userId },
              email: req.userEmail,
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
            store: { data: { type: 'stores', id: process.env.LS_STORE_ID } },
            variant: { data: { type: 'variants', id: variantId } },
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.LS_API_KEY}`,
          Accept: 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
        },
      }
    )

    const url = response.data?.data?.attributes?.url
    if (!url) throw new Error('No checkout URL returned')
    res.json({ url })
  } catch (err) {
    console.error('LS checkout error:', (err as any).response?.data || (err as Error).message)
    res.status(500).json({ error: 'Failed to create checkout session' })
  }
})

async function decrementRemaining(userId: string): Promise<void> {
  await redisCommand('DECR', 'fuelplan:remaining:' + userId)
}

async function getHistory(userId: string): Promise<HistoryEntry[]> {
  const raw = await redisCommand('GET', 'fuelplan:history:' + userId)
  if (!raw) return []
  try {
    return JSON.parse(raw)
  } catch {
    return []
  }
}

async function saveOrderRecord(order: OrderRecord): Promise<void> {
  const raw = await redisCommand('GET', 'fuelplan:orders')
  let orders: OrderRecord[] = []
  try {
    orders = raw ? JSON.parse(raw) : []
  } catch {
    orders = []
  }
  orders.unshift(order)
  if (orders.length > 1000) orders = orders.slice(0, 1000)
  await redisCommand('SET', 'fuelplan:orders', JSON.stringify(orders))
}

async function getAllOrders(): Promise<OrderRecord[]> {
  const raw = await redisCommand('GET', 'fuelplan:orders')
  try {
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

async function getRecipes(userId: string): Promise<RecipeRecord[]> {
  const raw = await redisCommand('GET', 'fuelplan:recipes:' + userId)
  if (!raw) return []
  try {
    return JSON.parse(raw)
  } catch {
    return []
  }
}

/**
 * Upserts a recipe (replaces in place if `recipe.id` matches an existing
 * entry, otherwise assigns a new id and unshifts). Throws if the box is
 * already at MAX_RECIPES and this would add a new entry — callers should
 * catch and surface that as a 400, not silently drop the save.
 */
async function saveRecipeRecord(userId: string, recipe: RecipeRecord): Promise<RecipeRecord> {
  const recipes = await getRecipes(userId)
  const existingIndex = recipes.findIndex((r) => r.id === recipe.id)
  if (existingIndex !== -1) {
    recipes[existingIndex] = { ...recipe, updatedAt: new Date().toISOString() }
  } else {
    if (recipes.length >= MAX_RECIPES) throw new Error('Recipe box is full — delete a recipe to save a new one.')
    recipe = { ...recipe, id: Date.now(), savedAt: recipe.savedAt || new Date().toISOString() }
    recipes.unshift(recipe)
  }
  await redisCommand('SET', 'fuelplan:recipes:' + userId, JSON.stringify(recipes))
  return existingIndex !== -1 ? recipes[existingIndex] : recipe
}

async function saveToHistory(userId: string, entry: HistoryEntry): Promise<void> {
  let history = await getHistory(userId)
  history.unshift(entry)
  if (history.length > MAX_HISTORY) {
    // Auto-archive overflow instead of hard deleting
    const overflow = history.slice(MAX_HISTORY)
    history = history.slice(0, MAX_HISTORY)
    try {
      const archiveRaw = await redisCommand('GET', 'fuelplan:archive:' + userId)
      let archive: ArchiveEntry[] = archiveRaw ? JSON.parse(archiveRaw) : []
      // Store only metadata in archive (no full plan JSON — save Redis space)
      overflow.forEach((e) => archive.unshift({ id: e.id, savedAt: e.savedAt, userName: e.userName, planName: e.planName, macros: e.macros }))
      archive = archive.slice(0, 50) // keep up to 50 archived plan records
      await redisCommand('SET', 'fuelplan:archive:' + userId, JSON.stringify(archive))
    } catch (e) {
      /* non-critical */
    }
  }
  await redisCommand('SET', 'fuelplan:history:' + userId, JSON.stringify(history))
}

// ── Weekly summary push notifications ─────────────────────────────────────────
async function sendWeeklySummaryNotifications(): Promise<void> {
  console.log('[Weekly] Sending weekly summary push notifications…')
  try {
    const userIds = await getAllUserIds()
    let totalSent = 0
    for (const userId of userIds) {
      const tokens = await getPushTokens(userId)
      if (!tokens.length) continue
      const tracking = await getTrackingData(userId)
      const weights = (tracking.weights || []).slice(0, 7)
      const latestWeight = weights[0] ? (weights[0] as any).displayVal : null
      const { sent, stale } = await sendExpoPush(tokens, {
        title: 'Fuelplan Weekly',
        body: latestWeight
          ? 'New week, new goals! Current weight: ' + latestWeight + '. Open your plan to get started.'
          : 'New week, new goals! Open Fuelplan to prep your meals.',
      })
      totalSent += sent
      if (stale.length) {
        const fresh = tokens.filter((t) => !stale.includes(t))
        await redisCommand('SET', 'fuelplan:push:' + userId, JSON.stringify(fresh))
      }
    }
    console.log('[Weekly] Sent ' + totalSent + ' notifications')
  } catch (e) {
    console.error('[Weekly] Error:', (e as Error).message)
  }
}

// Admin trigger for weekly summary
app.post('/api/admin/send-weekly', requireAdmin, async (req: Request, res: Response) => {
  await sendWeeklySummaryNotifications()
  res.json({ ok: true })
})

// Sunday 8pm UTC cron-style check (runs every hour, fires once on Sunday 20:xx)
const _weeklySentKey = 'fuelplan:weeklySentWeek'
setInterval(async () => {
  const now = new Date()
  if (now.getUTCDay() !== 0 || now.getUTCHours() !== 20) return // Sunday 8pm UTC only
  try {
    // Check we haven't sent this week already
    const weekNum = Math.floor(Date.now() / (7 * 24 * 3600 * 1000))
    const lastSent = await redisCommand('GET', _weeklySentKey)
    if (lastSent && parseInt(lastSent) === weekNum) return
    await redisCommand('SET', _weeklySentKey, String(weekNum))
    await sendWeeklySummaryNotifications()
  } catch (e) {
    console.error('[Weekly cron]', (e as Error).message)
  }
}, 3600000) // check every hour

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Fuelplan backend running on port ${PORT}`)
  if (!JWT_SECRET) console.error('WARNING: JWT_SECRET not set — auth endpoints will refuse all requests')
})
