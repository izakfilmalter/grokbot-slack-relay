export const REQUIRED_ENV = [
  'SLACK_SIGNING_SECRET',
  'SLACK_BOT_TOKEN',
  'ROUTINE_WEBHOOK_URL',
  'ROUTINE_WEBHOOK_KEY',
] as const

export type RelayConfig = Record<(typeof REQUIRED_ENV)[number], string>

export type ConfigResult =
  | { ok: true; config: RelayConfig }
  | { ok: false; missing: string[] }

/** Reads the four required env vars. Only ever reports names, never values. */
export function readConfig(env: Record<string, string | undefined>): ConfigResult {
  const missing = REQUIRED_ENV.filter((name) => !env[name]?.trim())
  if (missing.length > 0) return { ok: false, missing }
  return {
    ok: true,
    config: Object.fromEntries(REQUIRED_ENV.map((name) => [name, env[name]!.trim()])) as RelayConfig,
  }
}
