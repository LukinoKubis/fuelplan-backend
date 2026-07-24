import axios from 'axios'

const BUCKET = 'recipe-photos'

interface SupabaseConfig {
  url: string
  key: string
}

/**
 * Talks to Supabase Storage's REST API directly via axios rather than
 * `@supabase/supabase-js` — the SDK's `createClient()` unconditionally
 * constructs a Realtime client, which requires a native `WebSocket` global
 * only present in Node 22+. Railway resolves Node 20.20.2 for this project
 * (see package.json's `engines.node`), so every call through the SDK threw
 * "Node.js detected but native WebSocket not found" at runtime — confirmed
 * live via a real save-with-photo request that silently fell back to the
 * base64 path, then a debug log that caught the actual error. Same failure
 * class as the earlier `expo-server-sdk`/Node-version incident documented
 * for push notifications. We only need Storage here, not Realtime, so
 * talking to the REST API directly sidesteps the whole problem instead of
 * bumping the project's Node version just for this.
 */
function getConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  return url && key ? { url, key } : null
}

function parseDataUri(dataUri: string): { buffer: Buffer; contentType: string } | null {
  const m = dataUri.match(/^data:([^;]+);base64,(.+)$/)
  if (!m) return null
  return { contentType: m[1], buffer: Buffer.from(m[2], 'base64') }
}

/**
 * Uploads a recipe's cover photo (a base64 data URI, already resized/
 * compressed client-side by fuelplan-mobile's recipePhoto.ts) to Supabase
 * Storage, replacing the old base64-in-Redis approach — that stored the
 * full image inline on every RecipeRecord, which both bloated Redis
 * storage and meant /api/recipes/list re-downloaded every photo in full on
 * every load. Uses a deterministic per-recipe key (`userId/recipeId.ext`)
 * so re-uploading a new photo for the same recipe overwrites the old
 * object automatically instead of orphaning it. Returns the public URL to
 * store on the record instead of the raw blob. Throws if Supabase isn't
 * configured or the upload fails — the save endpoint catches this and
 * falls back to keeping the base64 inline.
 */
export async function uploadRecipePhoto(userId: string, recipeId: number, dataUri: string): Promise<string> {
  const config = getConfig()
  if (!config) throw new Error('Supabase not configured')
  const parsed = parseDataUri(dataUri)
  if (!parsed) throw new Error('Invalid photo data')

  const ext = parsed.contentType.split('/')[1] || 'jpg'
  const path = `${userId}/${recipeId}.${ext}`

  await axios.post(`${config.url}/storage/v1/object/${BUCKET}/${path}`, parsed.buffer, {
    headers: {
      Authorization: `Bearer ${config.key}`,
      apikey: config.key,
      'Content-Type': parsed.contentType,
      'x-upsert': 'true',
    },
  })

  return `${config.url}/storage/v1/object/public/${BUCKET}/${path}`
}

/** Best-effort cleanup when a recipe is deleted — never throws, storage cleanup isn't critical-path. Tries the extensions recipePhoto.ts actually produces (always JPEG today, PNG kept as a defensive extra). */
export async function deleteRecipePhoto(userId: string, recipeId: number): Promise<void> {
  const config = getConfig()
  if (!config) return
  try {
    await axios.delete(`${config.url}/storage/v1/object/${BUCKET}`, {
      headers: { Authorization: `Bearer ${config.key}`, apikey: config.key },
      data: { prefixes: [`${userId}/${recipeId}.jpeg`, `${userId}/${recipeId}.jpg`, `${userId}/${recipeId}.png`] },
    })
  } catch {
    // best-effort
  }
}
