import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_BASE_URL = 'https://api.specstream.ai'
export const DEFAULT_QUESTION = 'What are E2B sandboxes and how do AI agents use them?'
export const DEFAULT_OUTPUT_PATH = '/home/user/answer.md'
export const MAX_STEPS = 3
export const TARGET_EXTRACTED = 2
export const BATCH_SIZE = 3
export const SEARCH_NUM = 6
const REQUEST_TIMEOUT_MS = 30_000
const MAX_RETRY_WAIT_SECONDS = 10

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does',
  'for', 'from', 'how', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or',
  'that', 'the', 'their', 'them', 'they', 'this', 'to', 'use', 'used',
  'using', 'what', 'when', 'where', 'which', 'who', 'why', 'with',
])

export class SpecStreamError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'SpecStreamError'
  }
}

/**
 * @typedef {object} SearchSource
 * @property {string} url
 * @property {string} title
 * @property {string} snippet
 * @property {string | null} [site]
 * @property {string | null} [published]
 * @property {string | null} [modified]
 */

/**
 * @typedef {object} ExtractedSource
 * @property {string} url
 * @property {string} title
 * @property {string} text
 * @property {string} snippet
 * @property {string | null} [published]
 * @property {string | null} [modified]
 * @property {string | null} [readFrom]
 */

/**
 * @param {string | null} headerValue
 * @returns {number | null}
 */
function parseRetryAfter(headerValue) {
  if (!headerValue) return null
  const seconds = Number(headerValue)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

/**
 * @param {number} status
 * @param {string} rawText
 * @param {string} endpoint
 * @returns {Record<string, any>}
 */
function parseJsonResponse(status, rawText, endpoint) {
  /** @type {Record<string, any>} */
  let payload
  try {
    payload = JSON.parse(rawText)
  } catch {
    throw new SpecStreamError(`SpecStream ${endpoint} returned invalid JSON (HTTP ${status}).`)
  }

  if (status >= 400 || payload.error) {
    const code = payload.error?.code || `http_${status}`
    const message = payload.error?.message || `HTTP ${status} from ${endpoint}`
    throw new SpecStreamError(`SpecStream ${endpoint} failed (${code}): ${message}`)
  }

  if (!payload.data || typeof payload.data !== 'object') {
    throw new SpecStreamError(`SpecStream ${endpoint} response missing 'data' object.`)
  }
  return payload.data
}

export class SpecStreamClient {
  /**
   * @param {{ apiKey: string; baseUrl?: string; fetchFn?: typeof fetch }} options
   */
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, fetchFn = fetch }) {
    const cleanedKey = apiKey.trim()
    if (!cleanedKey) {
      throw new Error('SPECSTREAM_API_KEY must be non-empty.')
    }
    this.apiKey = cleanedKey
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.fetchFn = fetchFn
  }

  /**
   * @param {string} method
   * @param {string} endpointPath
   * @param {Record<string, unknown>} [body]
   * @returns {Promise<Record<string, any>>}
   */
  async requestJson(method, endpointPath, body) {
    const url = `${this.baseUrl}${endpointPath}`
    /** @type {Record<string, string>} */
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    }
    /** @type {RequestInit} */
    const init = {
      method,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.fetchFn(url, init)
      if (response.status === 503 && attempt === 0) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
        if (retryAfter !== null && retryAfter <= MAX_RETRY_WAIT_SECONDS) {
          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000))
          continue
        }
      }
      const rawText = await response.text()
      return parseJsonResponse(response.status, rawText, endpointPath.split('?')[0])
    }

    throw new SpecStreamError(`SpecStream ${endpointPath} failed after retry.`)
  }

  /**
   * @param {string} query
   * @param {{ speed?: string; num?: number; page?: number }} [options]
   */
  async webSearch(query, { speed = 'fast', num = SEARCH_NUM, page = 1 } = {}) {
    const params = new URLSearchParams({
      q: query,
      speed,
      num: String(num),
      page: String(page),
    })
    return this.requestJson('GET', `/v1/web-search?${params.toString()}`)
  }

  /**
   * @param {string[]} urls
   * @param {{ format?: string }} [options]
   */
  async extract(urls, { format = 'markdown' } = {}) {
    if (!urls.length) {
      throw new Error('urls must not be empty.')
    }
    return this.requestJson('POST', '/v1/extract', {
      urls: urls.slice(0, 20),
      format,
    })
  }
}

/**
 * @param {string} question
 * @returns {Set<string>}
 */
function keywords(question) {
  const tokens = question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []
  const filtered = tokens.filter((tok) => !STOP_WORDS.has(tok))
  return new Set(filtered.length ? filtered : tokens)
}

/**
 * Pick unvisited URLs, prioritizing distinct domains first for source diversity.
 * @param {SearchSource[]} candidates
 * @param {Set<string>} visited
 * @param {number} limit
 * @returns {string[]}
 */
function selectCandidateUrls(candidates, visited, limit) {
  /** @type {string[]} */
  const selected = []
  /** @type {Set<string>} */
  const seenSites = new Set()
  /** @type {string[]} */
  const deferred = []

  for (const src of candidates) {
    const url = src.url
    if (!url || visited.has(url) || selected.includes(url) || deferred.includes(url)) {
      continue
    }
    let hostname = ''
    try {
      hostname = new URL(url).hostname
    } catch {
      hostname = ''
    }
    const site = (src.site || hostname || '').toLowerCase()
    if (site && !seenSites.has(site)) {
      seenSites.add(site)
      selected.push(url)
      if (selected.length >= limit) return selected
    } else {
      deferred.push(url)
    }
  }

  for (const url of deferred) {
    if (selected.length >= limit) break
    selected.push(url)
  }
  return selected
}

/**
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function truncateCleanly(text, maxChars) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  const slice = normalized.slice(0, maxChars - 3)
  const lastSpace = slice.lastIndexOf(' ')
  const clipped = (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).replace(/[.,;:]+$/, '')
  return `${clipped}...`
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function cleanMarkdownLines(text) {
  const stripped = text.replace(/```[\s\S]*?```/g, ' ')
  /** @type {string[]} */
  const candidates = []

  for (const rawLine of stripped.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line) continue
    if (/^(#|!\[|---|\*\*\*|\|)/.test(line)) continue

    line = line.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    line = line.replace(/^[-*+]\s+/, '')
    line = line.replace(/[*_`]+/g, '').trim()
    if (line.length < 40) continue

    const lower = line.toLowerCase()
    if (['cookie', 'sign in', 'subscribe', 'all rights reserved'].some((noise) => lower.includes(noise))) {
      continue
    }

    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const trimmed = sentence.trim()
      if (trimmed.length >= 40) {
        candidates.push(trimmed)
      }
    }
  }

  return candidates
}

/**
 * @param {ExtractedSource} source
 * @param {Set<string>} queryTerms
 * @returns {string}
 */
function bestExcerpt(source, queryTerms) {
  const lines = cleanMarkdownLines(source.text)
  if (!lines.length) {
    const fallback = source.snippet.trim() || source.text.trim()
    return truncateCleanly(fallback, 260)
  }

  let bestSentence = lines[0]
  let bestScore = -1
  for (const sentence of lines.slice(0, 40)) {
    const words = new Set(sentence.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
    let overlap = 0
    for (const term of queryTerms) {
      if (words.has(term)) overlap += 1
    }
    if (overlap > bestScore) {
      bestScore = overlap
      bestSentence = sentence
    }
  }
  return truncateCleanly(bestSentence, 280)
}

/**
 * @param {string} question
 * @param {ExtractedSource[]} sources
 * @returns {string}
 */
export function formatSourcedAnswer(question, sources) {
  const queryTerms = keywords(question)
  const lines = ['# Answer', '', `**Question:** ${question}`, '']

  if (!sources.length) {
    lines.push('No relevant sources were found for this question.')
    return `${lines.join('\n')}\n`
  }

  lines.push('## Key findings', '')
  sources.forEach((source, idx) => {
    const excerpt = bestExcerpt(source, queryTerms)
    lines.push(`- ${excerpt} [${idx + 1}]`)
  })

  lines.push('', '## Sources', '')
  sources.forEach((source, idx) => {
    const title = source.title || source.url
    /** @type {string[]} */
    const details = []
    if (source.published) details.push(`published ${source.published}`)
    if (source.modified && source.modified !== source.published) details.push(`updated ${source.modified}`)
    if (source.readFrom) details.push(`read via ${source.readFrom}`)
    const suffix = details.length ? ` (${details.join(', ')})` : ''
    lines.push(`${idx + 1}. [${title}](${source.url})${suffix}`)
  })

  return `${lines.join('\n')}\n`
}

/**
 * Run an iterative search-and-extract loop until enough grounded sources are gathered.
 * @param {string} question
 * @param {SpecStreamClient} client
 * @param {{ maxSteps?: number; targetSources?: number; batchSize?: number; log?: (msg: string) => void }} [options]
 */
export async function runAgent(
  question,
  client,
  { maxSteps = MAX_STEPS, targetSources = TARGET_EXTRACTED, batchSize = BATCH_SIZE, log = console.log } = {},
) {
  /** @type {Set<string>} */
  const visitedUrls = new Set()
  /** @type {SearchSource[]} */
  const candidatePool = []
  /** @type {Map<string, SearchSource>} */
  const sourceMetaByUrl = new Map()
  /** @type {ExtractedSource[]} */
  const extracted = []

  let searchPage = 1
  /** @type {number | null} */
  let nextPage = 1
  let totalPriceUsd = 0
  let stepsTaken = 0

  for (let step = 1; step <= maxSteps; step++) {
    stepsTaken = step
    let batchUrls = selectCandidateUrls(candidatePool, visitedUrls, batchSize)

    if (!batchUrls.length && nextPage !== null) {
      const searchData = await client.webSearch(question, { speed: 'fast', num: SEARCH_NUM, page: searchPage })
      totalPriceUsd += Number(searchData.price_usd || 0)
      /** @type {SearchSource[]} */
      const newSources = Array.isArray(searchData.sources) ? searchData.sources : []
      for (const src of newSources) {
        if (src?.url && !sourceMetaByUrl.has(src.url)) {
          sourceMetaByUrl.set(src.url, src)
          candidatePool.push(src)
        }
      }
      nextPage = typeof searchData.next_page === 'number' ? searchData.next_page : null
      if (nextPage !== null) {
        searchPage = nextPage
      }
      log(`[step ${step}] web-search page returned ${newSources.length} sources`)
      batchUrls = selectCandidateUrls(candidatePool, visitedUrls, batchSize)
    }

    if (!batchUrls.length) {
      log(`[step ${step}] no remaining candidate URLs to extract`)
      break
    }

    for (const url of batchUrls) visitedUrls.add(url)
    const extractData = await client.extract(batchUrls, { format: 'markdown' })
    totalPriceUsd += Number(extractData.price_usd || 0)
    /** @type {Record<string, any>[]} */
    const results = Array.isArray(extractData.results) ? extractData.results : []

    let okInBatch = 0
    for (const item of results) {
      const url = item?.url
      const status = item?.status
      const text = typeof item?.text === 'string' ? item.text : ''
      if (status === 'ok' && text.trim() && typeof url === 'string') {
        const meta = sourceMetaByUrl.get(url)
        extracted.push({
          url,
          title: String(item.title || meta?.title || url).trim(),
          text,
          snippet: String(meta?.snippet || '').trim(),
          published: item.published || meta?.published || null,
          modified: item.modified || meta?.modified || null,
          readFrom: item.read_from || null,
        })
        okInBatch += 1
      }
    }

    log(`[step ${step}] extracted ${batchUrls.length} URLs -> ${okInBatch} ok (${extracted.length}/${targetSources} collected)`)
    if (extracted.length >= targetSources) {
      break
    }
  }

  // If live extraction was blocked or empty on every URL, fall back to search snippets.
  if (!extracted.length && candidatePool.length) {
    for (const src of candidatePool.slice(0, targetSources)) {
      if (!src.url) continue
      extracted.push({
        url: src.url,
        title: String(src.title || src.url).trim(),
        text: src.snippet || '',
        snippet: src.snippet || '',
        published: src.published || null,
        modified: src.modified || null,
      })
    }
  }

  const finalSources = extracted.slice(0, 3)
  const answerMarkdown = formatSourcedAnswer(question, finalSources)
  return {
    question,
    answerMarkdown,
    sources: finalSources,
    steps: stepsTaken,
    totalPriceUsd: Number(totalPriceUsd.toFixed(6)),
  }
}

export async function main() {
  const apiKey = (process.env.SPECSTREAM_API_KEY ?? '').trim()
  if (!apiKey) {
    console.error('Missing SPECSTREAM_API_KEY in environment.')
    return 1
  }

  const question = process.argv.slice(2).join(' ').trim() || (process.env.QUESTION ?? '').trim() || DEFAULT_QUESTION
  const outputPath = process.env.OUTPUT_PATH || DEFAULT_OUTPUT_PATH
  const baseUrl = process.env.SPECSTREAM_BASE_URL || DEFAULT_BASE_URL

  const client = new SpecStreamClient({ apiKey, baseUrl })
  const result = await runAgent(question, client)

  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, result.answerMarkdown, 'utf8')

  console.log(`\nWrote ${outputPath} in ${result.steps} step(s) (total API cost: $${result.totalPriceUsd.toFixed(4)})`)
  return 0
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntrypoint) {
  const exitCode = await main()
  process.exit(exitCode)
}
