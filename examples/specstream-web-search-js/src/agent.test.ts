import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SpecStreamClient, SpecStreamError, runAgent } from './agent.mjs'
import { AGENT_SANDBOX_PATH, OUTPUT_SANDBOX_PATH, requireKeys, runExample } from './index.js'

type RecordedCall = {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function createFakeFetch(
  responses: Array<{ status: number; headers?: Record<string, string>; body: unknown }>,
) {
  const calls: RecordedCall[] = []
  const queue = [...responses]

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ url, method, headers, body })

    const next = queue.shift()
    if (!next) throw new Error('Unexpected fetch call')
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers ?? {},
    })
  }

  return { calls, fakeFetch }
}

describe('SpecStream agent loop', () => {
  it('calls Search and Extract and writes a sourced answer', async () => {
    const { calls, fakeFetch } = createFakeFetch([
      {
        status: 200,
        body: {
          data: {
            request_id: 'req_search_1',
            query: 'E2B sandboxes',
            took_ms: 170,
            price_usd: 0.001,
            next_page: 2,
            sources: [
              {
                url: 'https://blocked.example.com/post',
                title: 'Blocked site',
                site: 'blocked.example.com',
                snippet: 'Blocked snippet',
              },
              {
                url: 'https://e2b.dev/docs',
                title: 'E2B Documentation',
                site: 'e2b.dev',
                snippet: 'E2B provides cloud sandboxes for AI agents.',
                published: '2026-03-10',
              },
              {
                url: 'https://specstream.ai/docs',
                title: 'SpecStream Docs',
                site: 'specstream.ai',
                snippet: 'SpecStream provides live web search and extract APIs.',
              },
            ],
          },
        },
      },
      {
        status: 200,
        body: {
          data: {
            request_id: 'req_extract_1',
            took_ms: 390,
            price_usd: 0.0016,
            results: [
              {
                url: 'https://blocked.example.com/post',
                status: 'blocked',
                title: null,
                text: '',
                published: null,
              },
              {
                url: 'https://e2b.dev/docs',
                status: 'ok',
                title: 'E2B Documentation',
                text: '# E2B\n\nE2B sandboxes give AI agents isolated cloud microVMs for running code safely.',
                published: '2026-03-10',
                read_from: 'live',
              },
              {
                url: 'https://specstream.ai/docs',
                status: 'ok',
                title: 'SpecStream Docs',
                text: 'Agents running inside sandboxes call SpecStream Search and Extract over HTTPS.',
                published: null,
                read_from: 'live',
              },
            ],
          },
        },
      },
    ])

    const client = new SpecStreamClient({ apiKey: 'ss_test_key', fetchFn: fakeFetch })
    const logs: string[] = []
    const result = await runAgent('How do AI agents use E2B sandboxes?', client, {
      targetSources: 2,
      log: (msg) => logs.push(msg),
    })

    assert.equal(result.steps, 1)
    assert.equal(result.sources.length, 2)
    assert.ok(Math.abs(result.totalPriceUsd - 0.0026) < 1e-9)
    assert.match(result.answerMarkdown, /\[1\]/)
    assert.match(result.answerMarkdown, /\[2\]/)
    assert.match(result.answerMarkdown, /https:\/\/e2b\.dev\/docs/)
    assert.match(result.answerMarkdown, /https:\/\/specstream\.ai\/docs/)

    assert.equal(calls[0].method, 'GET')
    assert.match(calls[0].url, /\/v1\/web-search\?/)
    assert.match(calls[0].url, /speed=fast/)
    assert.equal(calls[0].headers.Authorization, 'Bearer ss_test_key')

    assert.equal(calls[1].method, 'POST')
    assert.ok(calls[1].url.endsWith('/v1/extract'))
    assert.deepEqual(calls[1].body, {
      urls: [
        'https://blocked.example.com/post',
        'https://e2b.dev/docs',
        'https://specstream.ai/docs',
      ],
      format: 'markdown',
    })
  })

  it('iterates to a second batch when the first batch yields one ok page', async () => {
    const { fakeFetch } = createFakeFetch([
      {
        status: 200,
        body: {
          data: {
            request_id: 'req_search_2',
            query: 'test',
            took_ms: 120,
            price_usd: 0.001,
            next_page: null,
            sources: [
              { url: 'https://a.example.com', title: 'A', site: 'a.example.com', snippet: 'A' },
              { url: 'https://b.example.com', title: 'B', site: 'b.example.com', snippet: 'B' },
              { url: 'https://c.example.com', title: 'C', site: 'c.example.com', snippet: 'C' },
              { url: 'https://d.example.com', title: 'D', site: 'd.example.com', snippet: 'D' },
            ],
          },
        },
      },
      {
        status: 200,
        body: {
          data: {
            request_id: 'req_extract_a',
            took_ms: 200,
            price_usd: 0.0008,
            results: [
              {
                url: 'https://a.example.com',
                status: 'ok',
                title: 'A',
                text: 'Source A provides detailed benchmark numbers for search accuracy.',
                published: null,
              },
              { url: 'https://b.example.com', status: 'empty', title: null, text: '', published: null },
              { url: 'https://c.example.com', status: 'not_found', title: null, text: '', published: null },
            ],
          },
        },
      },
      {
        status: 200,
        body: {
          data: {
            request_id: 'req_extract_b',
            took_ms: 190,
            price_usd: 0.0008,
            results: [
              {
                url: 'https://d.example.com',
                status: 'ok',
                title: 'D',
                text: 'Source D confirms the extraction pipeline supports markdown output.',
                published: null,
              },
            ],
          },
        },
      },
    ])

    const client = new SpecStreamClient({ apiKey: 'ss_test_key', fetchFn: fakeFetch })
    const result = await runAgent('benchmark search extraction', client, {
      targetSources: 2,
      log: () => {},
    })

    assert.equal(result.steps, 2)
    assert.deepEqual(
      result.sources.map((s) => s.url),
      ['https://a.example.com', 'https://d.example.com'],
    )
  })

  it('throws SpecStreamError on API errors without leaking the key', async () => {
    const { fakeFetch } = createFakeFetch([
      {
        status: 401,
        body: { error: { code: 'invalid_token', message: 'Invalid API key.' } },
      },
    ])

    const client = new SpecStreamClient({ apiKey: 'ss_secret_value', fetchFn: fakeFetch })
    await assert.rejects(
      () => client.webSearch('test'),
      (err: unknown) => {
        if (!(err instanceof SpecStreamError) || !(err instanceof Error)) return false
        assert.match(err.message, /invalid_token/)
        assert.doesNotMatch(err.message, /ss_secret_value/)
        return true
      },
    )
  })
})

describe('Host runner', () => {
  it('validates E2B_API_KEY and SPECSTREAM_API_KEY', () => {
    assert.throws(() => requireKeys({ SPECSTREAM_API_KEY: 'ss_123' }), /E2B_API_KEY/)
    assert.throws(() => requireKeys({ E2B_API_KEY: 'e2b_123' }), /SPECSTREAM_API_KEY/)
    assert.deepEqual(
      requireKeys({ E2B_API_KEY: 'e2b_123', SPECSTREAM_API_KEY: 'ss_123' }),
      { e2bApiKey: 'e2b_123', specstreamApiKey: 'ss_123' },
    )
  })

  it('uploads agent.mjs, executes it in the sandbox, and kills the sandbox', async () => {
    const written = new Map<string, string>()
    const runs: Array<{ cmd: string; envs?: Record<string, string> }> = []
    let killed = false

    const answer = await runExample('What is E2B?', {
      env: { E2B_API_KEY: 'e2b_test', SPECSTREAM_API_KEY: 'ss_test' },
      sandboxFactory: async () => ({
        sandboxId: 'sbx_test_123',
        files: {
          write: async (filePath, data) => {
            written.set(filePath, data)
          },
          read: async (filePath) => {
            assert.equal(filePath, OUTPUT_SANDBOX_PATH)
            return '# Answer\n\nMocked sourced answer [1]\n'
          },
        },
        commands: {
          run: async (cmd, opts) => {
            runs.push({ cmd, envs: opts?.envs })
          },
        },
        kill: async () => {
          killed = true
        },
      }),
    })

    assert.match(answer, /Mocked sourced answer/)
    assert.equal(killed, true)
    assert.ok(written.has(AGENT_SANDBOX_PATH))
    assert.equal(runs.length, 1)
    assert.equal(runs[0].cmd, `node ${AGENT_SANDBOX_PATH}`)
    assert.deepEqual(runs[0].envs, {
      SPECSTREAM_API_KEY: 'ss_test',
      QUESTION: 'What is E2B?',
      OUTPUT_PATH: OUTPUT_SANDBOX_PATH,
    })
  })
})
