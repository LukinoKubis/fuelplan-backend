import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const BUCKET = 'recipe-photos'

let client: SupabaseClient | null | undefined

/** Lazily created, cached singleton — soft-disabled (returns null) if the env vars aren't set, matching this codebase's pattern for other optional integrations (OPENAI_API_KEY, RESEND_API_KEY). */
function getClient(): SupabaseClient | null {
  if (client !== undefined) return client
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  client = url && key ? createClient(url, key) : null
  return client
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
 * falls back to keeping the base64 inline, so a missing/misconfigured
 * SUPABASE_URL never breaks the cover-photo feature, just leaves it on
 * the old (working, just heavier) storage path.
 */
export async function uploadRecipePhoto(userId: string, recipeId: number, dataUri: string): Promise<string> {
  const supabase = getClient()
  if (!supabase) throw new Error('Supabase not configured')
  const parsed = parseDataUri(dataUri)
  if (!parsed) throw new Error('Invalid photo data')

  const ext = parsed.contentType.split('/')[1] || 'jpg'
  const path = `${userId}/${recipeId}.${ext}`
  const { error } = await supabase.storage.from(BUCKET).upload(path, parsed.buffer, { contentType: parsed.contentType, upsert: true })
  if (error) throw error

  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
}

/** Best-effort cleanup when a recipe is deleted — never throws, storage cleanup isn't critical-path. Tries the extensions recipePhoto.ts actually produces (always JPEG today, PNG kept as a defensive extra). */
export async function deleteRecipePhoto(userId: string, recipeId: number): Promise<void> {
  const supabase = getClient()
  if (!supabase) return
  try {
    await supabase.storage.from(BUCKET).remove([`${userId}/${recipeId}.jpeg`, `${userId}/${recipeId}.jpg`, `${userId}/${recipeId}.png`])
  } catch {
    // best-effort
  }
}
