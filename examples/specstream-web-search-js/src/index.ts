import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { Sandbox } from 'e2b'

export const AGENT_LOCAL_URL = new URL('./agent.mjs', import.meta.url)
export const AGENT_SANDBOX_PATH = '/home/user/agent.mjs'
export const OUTPUT_SANDBOX_PATH = '/home/user/answer.md'
export const DEFAULT_QUESTION = 'What are E2B sandboxes and how do AI agents use them?'
const SANDBOX_TIMEOUT_MS = 5 * 60_000
const COMMAND_TIMEOUT_MS = 2 * 60_000

/**
 * Validate required environment variables for the host and sandbox.
 */
export function requireKeys(env: Record<string, string | undefined>): {
  e2bApiKey: string
  specstreamApiKey: string
} {
  const e2bApiKey = (env.E2B_API_KEY ?? '').trim()
  if (!e2bApiKey) {
    throw new Error('Missing E2B_API_KEY. Copy .env.example to .env and fill in your keys.')
  }

  const specstreamApiKey = (env.SPECSTREAM_API_KEY ?? '').trim()
  if (!specstreamApiKey) {
    throw new Error('Missing SPECSTREAM_API_KEY. Copy .env.example to .env and fill in your keys.')
  }

  return { e2bApiKey, specstreamApiKey }
}

type SandboxLike = {
  sandboxId: string
  files: {
    write: (path: string, data: string) => Promise<unknown>
    read: (path: string) => Promise<string>
  }
  commands: {
    run: (
      cmd: string,
      opts?: {
        envs?: Record<string, string>
        timeoutMs?: number
        onStdout?: (data: string) => void
        onStderr?: (data: string) => void
      },
    ) => Promise<unknown>
  }
  kill: () => Promise<unknown>
}

export async function runExample(
  question?: string,
  options: {
    env?: Record<string, string | undefined>
    sandboxFactory?: (opts: { timeoutMs: number }) => Promise<SandboxLike>
  } = {},
): Promise<string> {
  const env = options.env ?? process.env
  const { specstreamApiKey } = requireKeys(env)
  const resolvedQuestion = (question ?? env.QUESTION ?? '').trim() || DEFAULT_QUESTION

  const agentSource = await readFile(AGENT_LOCAL_URL, 'utf8')
  const createSandbox = options.sandboxFactory ?? ((opts) => Sandbox.create(opts))
  const sbx = await createSandbox({ timeoutMs: SANDBOX_TIMEOUT_MS })
  console.log('Sandbox created:', sbx.sandboxId)

  try {
    await sbx.files.write(AGENT_SANDBOX_PATH, agentSource)
    await sbx.commands.run(`node ${AGENT_SANDBOX_PATH}`, {
      envs: {
        SPECSTREAM_API_KEY: specstreamApiKey,
        QUESTION: resolvedQuestion,
        OUTPUT_PATH: OUTPUT_SANDBOX_PATH,
      },
      timeoutMs: COMMAND_TIMEOUT_MS,
      onStdout: (data) => {
        process.stdout.write(data)
      },
      onStderr: (data) => {
        process.stderr.write(data)
      },
    })

    const answer = await sbx.files.read(OUTPUT_SANDBOX_PATH)
    console.log('\n--- answer.md ---\n' + answer)
    return answer
  } finally {
    await sbx.kill()
  }
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntrypoint) {
  const cliQuestion = process.argv.slice(2).join(' ').trim() || undefined
  runExample(cliQuestion).catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
}
