import { readConfig } from '../../src/config.js'
import { createSlackHandler } from '../../src/app.js'

let handler: ((req: Request) => Promise<Response>) | undefined

export async function POST(req: Request): Promise<Response> {
  const result = readConfig(process.env)
  if (!result.ok) {
    console.error(`[relay] not configured, missing env: ${result.missing.join(', ')}`)
    return Response.json({ error: 'relay_not_configured', missing: result.missing }, { status: 500 })
  }
  handler ??= createSlackHandler(result.config)
  return handler(req)
}

/** Health check: lists missing env var names (never values). */
export function GET(): Response {
  const result = readConfig(process.env)
  return Response.json(result.ok ? { ok: true } : { ok: false, missing: result.missing })
}
