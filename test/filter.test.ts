import { describe, expect, it } from 'vitest'
import {
  botIsInThread as botIsInThreadFor,
  decide as decideFor,
  isSlackRetry,
  RecentIds,
  type SlackMessageEvent,
} from '../src/filter.js'

const self = { userId: 'U0BOT', botId: 'B0BOT' }
const decide = (event: SlackMessageEvent) => decideFor(event, self)
const botIsInThread = (messages: Parameters<typeof botIsInThreadFor>[0]) => botIsInThreadFor(messages, self)

const base = { user: 'U123', text: 'hi', ts: '100.1', channel: 'C1' }

describe('decide', () => {
  it('forwards app mentions and DMs', () => {
    expect(decide({ ...base, type: 'app_mention', channel_type: 'channel' })).toEqual({
      action: 'forward',
      kind: 'mention',
    })
    expect(decide({ ...base, type: 'message', channel_type: 'im', channel: 'D1' })).toEqual({
      action: 'forward',
      kind: 'dm',
    })
  })

  it('drops bot and self messages', () => {
    expect(decide({ ...base, type: 'message', channel_type: 'im', bot_id: 'B999' })).toMatchObject({ reason: 'bot' })
    expect(decide({ ...base, type: 'message', channel_type: 'im', bot_id: self.botId })).toMatchObject({ reason: 'bot' })
    expect(decide({ ...base, type: 'message', channel_type: 'im', user: self.userId })).toMatchObject({ reason: 'self' })
  })

  it('drops edit, delete and join subtypes but keeps file shares', () => {
    for (const subtype of ['message_changed', 'message_deleted', 'channel_join', 'group_join']) {
      expect(decide({ ...base, type: 'message', channel_type: 'im', subtype })).toEqual({
        action: 'drop',
        reason: `subtype:${subtype}`,
      })
    }
    expect(decide({ ...base, type: 'message', channel_type: 'im', subtype: 'file_share' })).toEqual({
      action: 'forward',
      kind: 'dm',
    })
  })

  it('only considers threaded channel messages without a mention', () => {
    const msg = { ...base, type: 'message', channel_type: 'channel' }
    expect(decide(msg)).toMatchObject({ reason: 'not-threaded' })
    expect(decide({ ...msg, thread_ts: msg.ts })).toMatchObject({ reason: 'not-threaded' })
    expect(decide({ ...msg, thread_ts: '99.0' })).toEqual({ action: 'check-thread' })
    expect(decide({ ...msg, channel_type: 'group', thread_ts: '99.0' })).toEqual({ action: 'check-thread' })
    expect(decide({ ...msg, thread_ts: '99.0', text: `<@${self.userId}> again` })).toMatchObject({
      reason: 'covered-by-app_mention',
    })
    expect(decide({ ...msg, channel_type: 'mpim', thread_ts: '99.0' })).toMatchObject({ action: 'drop' })
  })
})

describe('botIsInThread', () => {
  it('detects the bot by post or mention', () => {
    expect(botIsInThread([{ user: 'U1', text: 'hello' }])).toBe(false)
    expect(botIsInThread([{ user: 'U1' }, { bot_id: self.botId }])).toBe(true)
    expect(botIsInThread([{ user: self.userId }])).toBe(true)
    expect(botIsInThread([{ user: 'U1', text: `hey <@${self.userId}>` }])).toBe(true)
  })
})

describe('isSlackRetry', () => {
  it('reads x-slack-retry-num', () => {
    expect(isSlackRetry(new Headers())).toBe(false)
    expect(isSlackRetry(new Headers({ 'x-slack-retry-num': '1' }))).toBe(true)
  })
})

describe('RecentIds', () => {
  it('flags duplicates and evicts the oldest past the cap', () => {
    const recent = new RecentIds(2)
    expect(recent.seen('a')).toBe(false)
    expect(recent.seen('a')).toBe(true)
    recent.seen('b')
    recent.seen('c')
    expect(recent.seen('a')).toBe(false)
  })
})
