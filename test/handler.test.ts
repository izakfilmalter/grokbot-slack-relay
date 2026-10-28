import { createHmac } from 'node:crypto'
import { webApi } from '@slack/bolt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSlackHandler } from '../src/app.js'
import { GET, POST } from '../api/slack/events.js'

const config = {
  SLACK_SIGNING_SECRET: 'test-signing-secret',
  SLACK_BOT_TOKEN: 'xoxb-test',
  ROUTINE_WEBHOOK_URL: 'https://routine.test/hook',
  ROUTINE_WEBHOOK_KEY: 'k-test',
}

function signedRequest(body: object, headers: Record<string, string> = {}, secret = config.SLACK_SIGNING_SECRET) {
  const raw = JSON.stringify(body)
  const ts = Math.floor(Date.now() / 1000).toString()
  const sig = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`
  return new Request('https://relay.test/api/slack/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig, ...headers },
    body: raw,
  })
}

const eventBody = (event: object, event_id = 'Ev1') => ({
  type: 'event_callback',
  team_id: 'T0TEAM',
  api_app_id: 'A0APP',
  event_id,
  event,
})

afterEach(() => vi.restoreAllMocks())

describe('slack handler', () => {
  it('answers url_verification', async () => {
    const res = await createSlackHandler(config)(signedRequest({ type: 'url_verification', challenge: 'abc' }))
    expect(await res.json()).toEqual({ challenge: 'abc' })
  })

  it('rejects bad signatures', async () => {
    const res = await createSlackHandler(config)(signedRequest({ type: 'url_verification', challenge: 'abc' }, {}, 'wrong'))
    expect(res.status).toBe(401)
  })

  it('acks retries without forwarding', async () => {
    const fetch = vi.fn()
    const res = await createSlackHandler(config, fetch)(
      signedRequest(eventBody({ type: 'app_mention', user: 'U1', text: 'x', ts: '1.1', channel: 'C1' }), {
        'x-slack-retry-num': '1',
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('x-slack-no-retry')).toBe('1')
    await new Promise((r) => setTimeout(r, 50))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('acks an app_mention and forwards it to the routine webhook', async () => {
    const apiCall = fakeSlackApi()
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const handler = createSlackHandler(config, fetch)
    const body = eventBody({ type: 'app_mention', user: 'U1', text: '<@U0BOT> hi', ts: '1.1', channel: 'C1' })

    const res = await handler(signedRequest(body))
    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(apiCall.mock.calls.map((c) => c[0])).toEqual(
      ['auth.test', 'users.info', 'chat.getPermalink'],
    )
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      event_id: 'Ev1',
      event_type: 'app_mention',
      kind: 'mention',
      user_name: 'Jane',
      permalink: 'https://x/p1',
    })

    // Same event_id again (e.g. a retry Slack sent without the header) is ignored.
    await handler(signedRequest(body))
    await new Promise((r) => setTimeout(r, 50))
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

function fakeSlackApi() {
  return vi.spyOn(webApi.WebClient.prototype, 'apiCall').mockImplementation(async (method: string) => {
    if (method === 'auth.test') return { ok: true, user_id: 'U0BOT', bot_id: 'B0BOT' }
    if (method === 'users.info') return { ok: true, user: { profile: { display_name: 'Jane' } } }
    if (method === 'chat.getPermalink') return { ok: true, permalink: 'https://x/p1' }
    return { ok: true }
  })
}

describe('slack handler: bot identity', () => {
  it('acks but forwards nothing when auth.test fails, then retries the lookup', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const apiCall = vi
      .spyOn(webApi.WebClient.prototype, 'apiCall')
      .mockRejectedValueOnce(new Error('invalid_auth'))
      .mockImplementation(async (method: string) =>
        method === 'auth.test' ? { ok: true, user_id: 'U0BOT', bot_id: 'B0BOT' } : { ok: true },
      )
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const handler = createSlackHandler(config, fetch)
    const dm = { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'yo', ts: '9.0' }

    const res = await handler(signedRequest(eventBody(dm, 'EvX')))
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 50))
    expect(fetch).not.toHaveBeenCalled()

    await handler(signedRequest(eventBody({ ...dm, ts: '9.1' }, 'EvY')))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(apiCall.mock.calls.filter((c) => c[0] === 'auth.test')).toHaveLength(2)
  })

  it("drops the bot's own DM messages using the auth.test identity", async () => {
    fakeSlackApi()
    const fetch = vi.fn()
    await createSlackHandler(config, fetch)(
      signedRequest(eventBody({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U0BOT', text: 'hi', ts: '9.2' })),
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('slack handler: agent threads', () => {
  const context = { channel_id: 'C42', team_id: 'T0TEAM', enterprise_id: null }
  const thread = { user_id: 'U1', channel_id: 'D1', thread_ts: '7.0' }

  it('forwards thread start, then follow-up messages with the remembered context', async () => {
    const apiCall = fakeSlackApi()
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const handler = createSlackHandler(config, fetch)
    const sent = () => fetch.mock.calls.map((c) => JSON.parse(c[1].body))

    await handler(
      signedRequest(
        eventBody({ type: 'assistant_thread_started', event_ts: '7.1', assistant_thread: { ...thread, context } }, 'EvA'),
      ),
    )
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(sent()[0]).toMatchObject({
      kind: 'assistant_thread_started',
      user: 'U1',
      assistant_thread: { channel_id: 'D1', thread_ts: '7.0', context },
    })

    const message = { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'help', ts: '7.2', thread_ts: '7.0' }
    await handler(signedRequest(eventBody(message, 'EvB')))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(sent()[1]).toMatchObject({
      kind: 'assistant_message',
      text: 'help',
      assistant_thread: { channel_id: 'D1', thread_ts: '7.0', context },
    })
    // Acts like a teammate: no status or reactions, only the identity lookup and payload lookups.
    expect(new Set(apiCall.mock.calls.map((c) => c[0]))).toEqual(
      new Set(['auth.test', 'users.info', 'chat.getPermalink']),
    )

    // The bot's own reply in the thread is not relayed.
    await handler(signedRequest(eventBody({ ...message, user: 'U0BOT', bot_id: 'B0BOT', ts: '7.3' }, 'EvC')))
    // A context change is forwarded with its new context.
    const changed = { channel_id: 'C77', team_id: 'T0TEAM', enterprise_id: null }
    await handler(
      signedRequest(
        eventBody(
          { type: 'assistant_thread_context_changed', event_ts: '7.4', assistant_thread: { ...thread, context: changed } },
          'EvD',
        ),
      ),
    )
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    expect(sent()[2]).toMatchObject({ kind: 'assistant_thread_context_changed', assistant_thread: { context: changed } })
    // The bot's own identity is looked up once and reused.
    expect(apiCall.mock.calls.filter((c) => c[0] === 'auth.test')).toHaveLength(1)
  })

  it('still treats top-level DMs as plain dm', async () => {
    fakeSlackApi()
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    await createSlackHandler(config, fetch)(
      signedRequest(eventBody({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'yo', ts: '8.0' })),
    )
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ kind: 'dm', assistant_thread: null })
  })
})

describe('api/slack/events', () => {
  it('fails clearly, naming missing env vars, when unconfigured', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const name of Object.keys(config)) vi.stubEnv(name, '')
    const res = await POST(signedRequest({ type: 'url_verification', challenge: 'abc' }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'relay_not_configured', missing: Object.keys(config) })
    expect(await GET().json()).toEqual({ ok: false, missing: Object.keys(config) })
    vi.unstubAllEnvs()
  })
})
