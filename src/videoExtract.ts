// Reads ingredients/steps that only exist as spoken audio or on-screen text
// overlays in a TikTok video — the caption (fetched separately via TikTok's
// oEmbed on the client) often doesn't have them at all.
//
// This is a real scrape, not an official API: TikTok's video CDN 403s a
// plain server-side fetch (confirmed — Akamai edge, likely blocking
// datacenter IPs/missing session context regardless of headers), but a
// real headless-Chromium page load succeeds and lets us intercept the
// actual video response. That means every extraction spins up a full
// browser, not a lightweight HTTP call — expect real latency (several
// seconds) and real Railway CPU/memory cost per call, not a cheap API hit.
// Fragile by nature: breaks if TikTok changes their page structure or
// tightens bot detection further. Instagram is NOT supported here — its
// post pages don't expose a directly fetchable video URL the same way,
// and reliably scraping it would need a logged-in session, a materially
// bigger lift not attempted yet.
import { chromium } from 'playwright'
import ffmpegPath from 'ffmpeg-static'
import { spawn } from 'node:child_process'
import { writeFile, readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import axios from 'axios'
import OpenAI from 'openai'

const MAX_VIDEO_BYTES = 30 * 1024 * 1024
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'

export interface VideoExtractResult {
  transcript: string
  onScreenText: string
  warnings: string[]
}

/**
 * Loads the TikTok video page in a real headless browser and intercepts
 * the actual video file response. Genuinely flaky by nature (real network
 * timing, occasional bot-check pages) — one retry with a fresh browser
 * before giving up, and `waitForResponse`'s predicate checks body size
 * itself so it doesn't resolve on the small non-video responses that share
 * the same URL path pattern (confirmed happens — a ~600 byte response on
 * the same /video/tos/ path arrives before the real multi-MB one).
 */
async function downloadTikTokVideoOnce(url: string): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  try {
    const page = await browser.newPage({ userAgent: USER_AGENT })
    const responsePromise = page.waitForResponse(
      async (res) => {
        if (!/\/video\/tos\//.test(res.url()) || res.status() !== 200) return false
        try {
          const buf = await res.body()
          return buf.length > 50_000
        } catch {
          return false
        }
      },
      { timeout: 20000 }
    )
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const res = await responsePromise
    const buf = await res.body()
    if (buf.length > MAX_VIDEO_BYTES) throw new Error('Video is too large to process.')
    return buf
  } finally {
    await browser.close().catch(() => {})
  }
}

async function downloadTikTokVideo(url: string): Promise<Buffer> {
  try {
    return await downloadTikTokVideoOnce(url)
  } catch {
    try {
      return await downloadTikTokVideoOnce(url)
    } catch {
      throw new Error('Could not find the video on the page — it may be private, removed, or TikTok changed their page structure.')
    }
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath as unknown as string, args)
    let stderr = ''
    proc.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error('ffmpeg failed: ' + stderr.slice(-500)))
    })
  })
}

/** Writes the video to a temp dir, pulls out the audio track and a handful of sampled frames. Caller must call the returned cleanup(). */
async function extractAudioAndFrames(videoBuffer: Buffer) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fp-video-'))
  const videoPath = path.join(dir, 'input.mp4')
  await writeFile(videoPath, videoBuffer)

  const audioPath = path.join(dir, 'audio.mp3')
  await runFfmpeg(['-y', '-i', videoPath, '-vn', '-acodec', 'libmp3lame', '-ar', '16000', '-ac', '1', audioPath])

  // One frame every 3s, capped at 6 — covers the first ~18s of a clip.
  // Most recipe-caption-style videos are short; a longer video just gets
  // its opening sampled, a known v1 limitation, not a bug.
  await runFfmpeg(['-y', '-i', videoPath, '-vf', 'fps=1/3', '-frames:v', '6', path.join(dir, 'frame-%d.jpg')])
  const files = await readdir(dir)
  const framePaths = files
    .filter((f) => f.startsWith('frame-'))
    .sort()
    .map((f) => path.join(dir, f))

  return {
    audioPath,
    framePaths,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

/** Whisper transcription of the audio track. Returns '' (not an error) if no API key is configured yet — audio-reading is a soft-optional enhancement, not a hard requirement to get on-screen text and the caption. */
async function transcribeAudio(audioPath: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) return ''
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const result = await client.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: 'whisper-1',
  })
  return result.text || ''
}

/** Asks Claude to read any on-screen text overlays across the sampled frames — reuses the existing Anthropic key, no new provider needed for this half. */
async function readOnScreenText(framePaths: string[]): Promise<string> {
  if (!framePaths.length) return ''
  const images = await Promise.all(
    framePaths.map(async (p) => {
      const buf = await readFile(p)
      return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } }
    })
  )
  const content = [
    ...images,
    {
      type: 'text',
      text: 'These are frames sampled in order from a short recipe video. If any frame shows on-screen text overlays (ingredient names, quantities, steps, labels), transcribe exactly what they say. Skip frames with no readable text. Reply with plain text only, no preamble, no markdown.',
    },
  ]
  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-6', max_tokens: 800, messages: [{ role: 'user', content }] },
    { headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, timeout: 60000 }
  )
  return response.data?.content?.[0]?.text || ''
}

/** Full pipeline: download -> extract audio+frames -> transcribe + read on-screen text, in parallel. Never throws for a missing OpenAI key or a failed sub-step — callers get whatever text was actually recoverable plus warnings explaining any gaps. */
export async function extractTikTokVideoText(url: string): Promise<VideoExtractResult> {
  const warnings: string[] = []
  const videoBuffer = await downloadTikTokVideo(url)
  const { audioPath, framePaths, cleanup } = await extractAudioAndFrames(videoBuffer)

  try {
    const [transcript, onScreenText] = await Promise.all([
      transcribeAudio(audioPath).catch((e) => {
        warnings.push('Audio transcription failed: ' + (e as Error).message)
        return ''
      }),
      readOnScreenText(framePaths).catch((e) => {
        warnings.push('Reading on-screen text failed: ' + (e as Error).message)
        return ''
      }),
    ])
    if (!process.env.OPENAI_API_KEY) warnings.push('Audio transcription is not configured yet — only on-screen text and the caption were read.')
    return { transcript, onScreenText, warnings }
  } finally {
    await cleanup()
  }
}
