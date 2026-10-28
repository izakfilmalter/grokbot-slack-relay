import { type BotIdentity, botIsInThread, decide, RecentIds, type SlackMessageEvent } from './filter.js'

export type Kind =
  | 'mention'
  | 'dm'
  | 'thread_reply'
  | 'assistant_thread_started'
  | 'assistant_thread_context_changed'
  | 'assistant_message'

/** Where the user had the agent container open (channel/team they were viewing). */
export interface AssistantContext {
  channel_id?: string
  team_id?: string
  enterprise_id?: string | null
}

export interface RelayPayload {
  event_id: string
  event_type: string
  kind: Kind
  team: string
  channel: string
  channel_type: string | null
  user: string
  user_name: string | null
  text: string
  ts: string
  thread_ts: string | null
  permalink: string | null
  assistant_thread: { channel_id: string; thread_ts: string; context: AssistantContext | null } | null
}

export interface AssistantThreadEvent {
  type: 'assistant_thread_started' | 'assistant_thread_context_changed'
  event_ts: string
  assistant_thread: { user_id: string; channel_id: string; thread_ts: string; context?: AssistantContext }
}

// The subset of Bolt's WebClient the relay uses, so tests can fake it.
export interface SlackClient {
  users: {
    info(args: { user: string }): Promise<{
      user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } }
    }>
  }
  chat: { getPermalink(args: { channel: string; message_ts: string }): Promise<{ permalink?: string }> }
  conversations: {
    replies(args: { channel: string; ts: string; limit?: number }): Promise<{
      messages?: Array<{ user?: string; bot_id?: string; text?: string }>
    }>
  }
}

export interface RelayDeps {
  client: SlackClient
  self: BotIdentity
  webhookUrl: string
  webhookKey: string
  recent: RecentIds
  fetch?: typeof fetch
  log?: Pick<Console, 'info' | 'warn' | 'error'>
}

/** Set for messages Bolt's Assistant routed from inside an agent thread. */
export interface AssistantMessageExtras {
  context: AssistantContext | null
}

export type RelayResult = { forwarded: true } | { forwarded: false; reason: string }

type Envelope = { event_id: string; team_id: string }

export async function relayEvent(
  envelope: Envelope,
  event: SlackMessageEvent,
  deps: RelayDeps,
  assistant?: AssistantMessageExtras,
): Promise<RelayResult> {
  const decision = decide(event, deps.self)
  if (decision.action === 'drop') return { forwarded: false, reason: decision.reason }
  if (deps.recent.seen(envelope.event_id)) return { forwarded: false, reason: 'duplicate' }

  const { client } = deps
  if (decision.action === 'check-thread') {
    const replies = await client.conversations.replies({ channel: event.channel, ts: event.thread_ts!, limit: 200 })
    if (!botIsInThread(replies.messages ?? [], deps.self)) return { forwarded: false, reason: 'thread-without-bot' }
  }
  const kind: Kind = assistant ? 'assistant_message' : decision.action === 'forward' ? decision.kind : 'thread_reply'

  const [userName, permalink] = await Promise.allSettled([
    displayName(client, event.user!),
    client.chat.getPermalink({ channel: event.channel, message_ts: event.ts }),
  ])

  return post(
    {
      event_id: envelope.event_id,
      event_type: event.type,
      kind,
      team: envelope.team_id,
      channel: event.channel,
      channel_type: event.channel_type ?? null,
      user: event.user!,
      user_name: userName.status === 'fulfilled' ? userName.value : null,
      text: event.text ?? '',
      ts: event.ts,
      thread_ts: event.thread_ts ?? null,
      permalink: permalink.status === 'fulfilled' ? (permalink.value.permalink ?? null) : null,
      assistant_thread: assistant
        ? { channel_id: event.channel, thread_ts: event.thread_ts!, context: assistant.context }
        : null,
    },
    deps,
  )
}

export async function relayAssistantThreadEvent(
  envelope: Envelope,
  event: AssistantThreadEvent,
  deps: RelayDeps,
): Promise<RelayResult> {
  const thread = event.assistant_thread
  if (!thread?.user_id) return { forwarded: false, reason: 'no-user' }
  if (deps.recent.seen(envelope.event_id)) return { forwarded: false, reason: 'duplicate' }

  const [userName] = await Promise.allSettled([displayName(deps.client, thread.user_id)])
  return post(
    {
      event_id: envelope.event_id,
      event_type: event.type,
      kind: event.type,
      team: envelope.team_id,
      channel: thread.channel_id,
      channel_type: 'im',
      user: thread.user_id,
      user_name: userName.status === 'fulfilled' ? userName.value : null,
      text: '',
      ts: event.event_ts,
      thread_ts: thread.thread_ts,
      permalink: null,
      assistant_thread: { channel_id: thread.channel_id, thread_ts: thread.thread_ts, context: thread.context ?? null },
    },
    deps,
  )
}

async function displayName(client: SlackClient, user: string): Promise<string | null> {
  const info = (await client.users.info({ user })).user
  return info?.profile?.display_name || info?.profile?.real_name || info?.real_name || info?.name || null
}

async function post(payload: RelayPayload, deps: RelayDeps): Promise<RelayResult> {
  const log = deps.log ?? console
  const res = await (deps.fetch ?? fetch)(deps.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.webhookKey}` },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    log.error(`[relay] webhook responded ${res.status} for ${payload.event_id}`)
    return { forwarded: false, reason: `webhook-${res.status}` }
  }
  log.info(`[relay] forwarded ${payload.event_id} (${payload.kind})`)
  return { forwarded: true }
}
