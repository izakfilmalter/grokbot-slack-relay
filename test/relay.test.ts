import { describe, expect, it, vi } from 'vitest'
import { RecentIds, type SlackMessageEvent } from '../src/filter.js'
import { relayAssistantThreadEvent, relayEvent, type SlackClient } from '../src/relay.js'

const self = { userId: 'U0BOT', botId: 'B0BOT' }
const envelope = { event_id: 'Ev1', team_id: 'T0TEAM' }

function fakeClient(threadMessages: Array<{ user?: string; text?: string }> = []) {
  return {
    users: { info: vi.fn().mockResolvedValue({ user: { name: 'jdoe', profile: { display_name: 'Jane' } } }) },
    chat: { getPermalink: vi.fn().mockResolvedValue({ permalink: 'https://example.slack.com/archives/D1/p1' }) },
    conversations: { replies: vi.fn().mockResolvedValue({ messages: threadMessages }) },
  } satisfies SlackClient
}

function deps(client: SlackClient, status = 200) {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status }))
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return { client, self, fetch, log, recent: new RecentIds(), webhookUrl: 'https://routine.test/hook', webhookKey: 'k-test' }
}

const dm: SlackMessageEvent = { type: 'message', channel_type: 'im', channel: 'D1', user: 'U123', text: 'hey', ts: '1.1' }

describe('relayEvent', () => {
  it('enriches and POSTs the payload with the bearer key', async () => {
    const client = fakeClient()
    const d = deps(client)
    expect(await relayEvent(envelope, dm, d)).toEqual({ forwarded: true })

    const [url, init] = d.fetch.mock.calls[0]
    expect(url).toBe('https://routine.test/hook')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ authorization: 'Bearer k-test', 'content-type': 'application/json' })
    expect(JSON.parse(init.body)).toEqual({
      event_id: 'Ev1',
      event_type: 'message',
      kind: 'dm',
      team: 'T0TEAM',
      channel: 'D1',
      channel_type: 'im',
      user: 'U123',
      user_name: 'Jane',
      text: 'hey',
      ts: '1.1',
      thread_ts: null,
      permalink: 'https://example.slack.com/archives/D1/p1',
      assistant_thread: null,
    })
  })

  it('labels app mentions', async () => {
    const d = deps(fakeClient())
    const mention: SlackMessageEvent = { ...dm, type: 'app_mention', channel_type: 'channel', channel: 'C1' }
    await relayEvent(envelope, mention, d)
    expect(JSON.parse(d.fetch.mock.calls[0][1].body)).toMatchObject({ kind: 'mention', event_type: 'app_mention' })
  })

  it('still forwards when enrichment calls fail', async () => {
    const client = fakeClient()
    client.users.info.mockRejectedValue(new Error('ratelimited'))
    client.chat.getPermalink.mockRejectedValue(new Error('ratelimited'))
    const d = deps(client)
    expect(await relayEvent(envelope, dm, d)).toEqual({ forwarded: true })
    expect(JSON.parse(d.fetch.mock.calls[0][1].body)).toMatchObject({ user_name: null, permalink: null })
  })

  it('drops duplicates and filtered events without calling anything', async () => {
    const client = fakeClient()
    const d = deps(client)
    await relayEvent(envelope, dm, d)
    expect(await relayEvent(envelope, dm, d)).toEqual({ forwarded: false, reason: 'duplicate' })
    expect(await relayEvent({ ...envelope, event_id: 'Ev2' }, { ...dm, bot_id: 'B1' }, d)).toEqual({
      forwarded: false,
      reason: 'bot',
    })
    expect(d.fetch).toHaveBeenCalledTimes(1)
  })

  it('forwards thread follow-ups only when the bot is in the thread', async () => {
    const reply: SlackMessageEvent = { ...dm, channel_type: 'channel', channel: 'C1', ts: '2.2', thread_ts: '2.0' }

    const outside = deps(fakeClient([{ user: 'U9', text: 'unrelated' }]))
    expect(await relayEvent(envelope, reply, outside)).toEqual({ forwarded: false, reason: 'thread-without-bot' })
    expect(outside.fetch).not.toHaveBeenCalled()

    const inside = deps(fakeClient([{ user: 'U9', text: `<@${self.userId}> help` }, { user: self.userId }]))
    expect(await relayEvent(envelope, reply, inside)).toEqual({ forwarded: true })
    expect(inside.client.conversations.replies).toHaveBeenCalledWith({ channel: 'C1', ts: '2.0', limit: 200 })
    expect(JSON.parse(inside.fetch.mock.calls[0][1].body)).toMatchObject({
      kind: 'thread_reply',
      thread_ts: '2.0',
      channel_type: 'channel',
    })
  })

  it('reports webhook failures without leaking the key', async () => {
    const d = deps(fakeClient(), 502)
    expect(await relayEvent(envelope, dm, d)).toEqual({ forwarded: false, reason: 'webhook-502' })
    expect(JSON.stringify(d.log.error.mock.calls)).not.toContain('k-test')
  })
})

describe('assistant events', () => {
  const context = { channel_id: 'C42', team_id: 'T0TEAM', enterprise_id: null }
  const threadEvent = (type: 'assistant_thread_started' | 'assistant_thread_context_changed') => ({
    type,
    event_ts: '5.5',
    assistant_thread: { user_id: 'U123', channel_id: 'D1', thread_ts: '5.0', context },
  })

  it('forwards thread started and context changed with the thread context', async () => {
    for (const type of ['assistant_thread_started', 'assistant_thread_context_changed'] as const) {
      const d = deps(fakeClient())
      expect(await relayAssistantThreadEvent(envelope, threadEvent(type), d)).toEqual({ forwarded: true })
      expect(JSON.parse(d.fetch.mock.calls[0][1].body)).toEqual({
        event_id: 'Ev1',
        event_type: type,
        kind: type,
        team: 'T0TEAM',
        channel: 'D1',
        channel_type: 'im',
        user: 'U123',
        user_name: 'Jane',
        text: '',
        ts: '5.5',
        thread_ts: '5.0',
        permalink: null,
        assistant_thread: { channel_id: 'D1', thread_ts: '5.0', context },
      })
    }
  })

  it('dedupes assistant thread events', async () => {
    const d = deps(fakeClient())
    await relayAssistantThreadEvent(envelope, threadEvent('assistant_thread_started'), d)
    expect(await relayAssistantThreadEvent(envelope, threadEvent('assistant_thread_started'), d)).toEqual({
      forwarded: false,
      reason: 'duplicate',
    })
  })

  const inThread: SlackMessageEvent = { ...dm, ts: '5.6', thread_ts: '5.0' }

  it('forwards assistant messages with the thread context', async () => {
    const d = deps(fakeClient())
    expect(await relayEvent(envelope, inThread, d, { context })).toEqual({ forwarded: true })
    expect(JSON.parse(d.fetch.mock.calls[0][1].body)).toMatchObject({
      kind: 'assistant_message',
      text: 'hey',
      thread_ts: '5.0',
      assistant_thread: { channel_id: 'D1', thread_ts: '5.0', context },
    })
  })

  it('reports webhook failures and ignores the bot replying in the thread', async () => {
    const d = deps(fakeClient(), 500)
    expect(await relayEvent(envelope, inThread, d, { context: null })).toEqual({
      forwarded: false,
      reason: 'webhook-500',
    })
    expect(
      await relayEvent({ ...envelope, event_id: 'Ev9' }, { ...inThread, bot_id: self.botId }, d, { context: null }),
    ).toEqual({ forwarded: false, reason: 'bot' })
  })
})
