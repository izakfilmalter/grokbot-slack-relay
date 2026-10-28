/** The relay's own bot, as reported by auth.test for SLACK_BOT_TOKEN. */
export interface BotIdentity {
  userId: string
  botId: string
}

export interface SlackMessageEvent {
  type: string
  subtype?: string
  user?: string
  bot_id?: string
  bot_profile?: unknown
  text?: string
  ts: string
  thread_ts?: string
  channel: string
  channel_type?: string
}

export type Decision =
  | { action: 'forward'; kind: 'mention' | 'dm' }
  | { action: 'check-thread' }
  | { action: 'drop'; reason: string }

// Subtypes that are still a human talking. Everything else (edits, deletes,
// joins, topic changes, ...) is dropped.
const HUMAN_SUBTYPES = new Set(['file_share', 'thread_broadcast'])

export function decide(event: SlackMessageEvent, self: BotIdentity): Decision {
  if (event.bot_id || event.bot_profile) return { action: 'drop', reason: 'bot' }
  if (!event.user) return { action: 'drop', reason: 'no-user' }
  if (event.user === self.userId) return { action: 'drop', reason: 'self' }
  if (event.subtype && !HUMAN_SUBTYPES.has(event.subtype)) {
    return { action: 'drop', reason: `subtype:${event.subtype}` }
  }

  if (event.type === 'app_mention') return { action: 'forward', kind: 'mention' }
  if (event.type !== 'message') return { action: 'drop', reason: `type:${event.type}` }

  if (event.channel_type === 'im') return { action: 'forward', kind: 'dm' }
  if (event.channel_type !== 'channel' && event.channel_type !== 'group') {
    return { action: 'drop', reason: `channel_type:${event.channel_type}` }
  }

  // Channel/group messages only matter as follow-ups inside threads.
  if (!event.thread_ts || event.thread_ts === event.ts) return { action: 'drop', reason: 'not-threaded' }
  // Slack also sends app_mention for these; forward that one only.
  if (event.text?.includes(`<@${self.userId}>`)) return { action: 'drop', reason: 'covered-by-app_mention' }
  return { action: 'check-thread' }
}

/** True when the bot has posted in, or been mentioned in, the thread. */
export function botIsInThread(
  messages: Array<{ user?: string; bot_id?: string; text?: string }>,
  self: BotIdentity,
): boolean {
  return messages.some(
    (m) => m.user === self.userId || m.bot_id === self.botId || m.text?.includes(`<@${self.userId}>`),
  )
}

/** Slack retries are dropped outright; the first delivery already forwarded. */
export function isSlackRetry(headers: Headers): boolean {
  return headers.has('x-slack-retry-num')
}

/** Small insertion-ordered map that evicts its oldest entry past `max`. */
export class BoundedMap<V> {
  private entries = new Map<string, V>()
  constructor(private readonly max = 1000) {}

  get(key: string): V | undefined {
    return this.entries.get(key)
  }

  set(key: string, value: V): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!)
  }
}

/** Per-instance memory of recent event_ids (Fluid compute reuses instances). */
export class RecentIds {
  private ids: BoundedMap<true>
  constructor(max = 1000) {
    this.ids = new BoundedMap(max)
  }

  /** Returns true if the id was already seen; records it otherwise. */
  seen(id: string): boolean {
    if (this.ids.get(id)) return true
    this.ids.set(id, true)
    return false
  }
}
