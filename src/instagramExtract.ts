// Reads an Instagram post/reel's caption — Instagram's oEmbed and API
// don't expose it without Meta App Review, but the post page's
// `og:description` meta tag carries it verbatim (format: "N likes, N
// comments - username on <date>: "<caption text>"."), confirmed live
// against a real public post. That meta tag is injected client-side by
// Instagram's own React app, not present in the raw server HTML (a plain
// fetch finds nothing), so this needs the same real-headless-Chromium
// approach as videoExtract.ts's TikTok video download — but the
// extraction itself is much simpler and faster: no video/audio/ffmpeg at
// all, just navigate and read one meta tag.
//
// Only works for genuinely public posts — Instagram still shows a login
// wall for some content (age-restricted, some accounts under load,
// private accounts), which surfaces as this function finding no caption
// and the caller falling back to manual paste, same as before this existed.
import { chromium } from 'playwright'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'

// Codepoints, not literal characters or a regex escape, deliberately — an
// invisible Unicode character pasted directly into source (or into a
// regex character class written with \u escapes) is impossible to review
// or grep for. Instagram sprinkles these direction/formatting marks into
// the og:description string (one sits right at the very end), which
// silently broke a naive string-matching approach: the trailing mark
// isn't whitespace, so anything anchored on "ends right after the closing
// quote" failed to match at all.
const INVISIBLE_MARK_CODEPOINTS = new Set([
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, // zero-width space/joiners, LRM/RLM
  0x2028, 0x2029, // line/paragraph separators
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x202f, // bidi embedding/override marks, narrow no-break space
  0xfeff, // BOM / zero-width no-break space
])

function stripInvisibleMarks(s: string): string {
  return Array.from(s)
    .filter((ch) => !INVISIBLE_MARK_CODEPOINTS.has(ch.codePointAt(0)!))
    .join('')
}

/** Strips Instagram's `N likes, N comments - username on <date>: "..."."` wrapper down to just the quoted caption text. */
function unwrapCaption(ogDescription: string): string {
  const cleaned = stripInvisibleMarks(ogDescription)
  const colonIndex = cleaned.indexOf(': "')
  const lastQuote = cleaned.lastIndexOf('"')
  if (colonIndex === -1 || lastQuote <= colonIndex + 3) return cleaned.trim()
  return cleaned.slice(colonIndex + 3, lastQuote).trim()
}

async function readCaptionOnce(url: string): Promise<string> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  try {
    const page = await browser.newPage({ userAgent: USER_AGENT })
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    // The meta tag is injected after Instagram's app hydrates — poll for
    // it rather than a fixed sleep, same reasoning as the TikTok download.
    await page
      .waitForFunction(() => !!document.querySelector('meta[property="og:description"]')?.getAttribute('content'), { timeout: 15000 })
      .catch(() => {
        /* may just not exist for this post (private/age-gated) — checked below instead of throwing here */
      })
    const content = await page.evaluate(() => document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '')
    if (!content) throw new Error('No caption found — this post may be private, age-restricted, or removed.')
    return unwrapCaption(content)
  } finally {
    await browser.close().catch(() => {})
  }
}

/** One retry with a fresh browser before giving up — same flakiness reasoning as TikTok's download. */
export async function extractInstagramCaption(url: string): Promise<string> {
  try {
    return await readCaptionOnce(url)
  } catch {
    return await readCaptionOnce(url)
  }
}
