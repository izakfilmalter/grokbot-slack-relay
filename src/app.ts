import { App, Assistant, type Context, LogLevel } from '@slack/bolt'
import { createHandler, VercelReceiver } from '@vercel/slack-bolt'
import type { RelayConfig } from './config.js'
import { BoundedMap, isSlackRetry, RecentIds, type SlackMessageEvent } from './filter.js'
import {
  type AssistantContext,
  type AssistantThreadEvent,
  relayAssistantThreadEvent,
  relayEvent,
  type RelayDeps,
  type RelayResult,
  type SlackClient,
} from './relay.js'

type Envelope = { event_id: string; team_id: string }
type ListenerArgs = { body: unknown; event: unknown; client: unknown; context: Context }

export function createSlackHandler(config: RelayConfig, fetchImpl?: typeof fetch) {
  const receiver = new VercelReceiver({
    signingSecret: config.SLACK_SIGNING_SECRET,
    logLevel: LogLevel.WARN,
    // Ack retries without reprocessing and ask Slack to stop retrying.
    beforeProcess: async (req) =>
      isSlackRetry(req.headers) ? new Response(null, { status: 200, headers: { 'x-slack-no-retry': '1' } }) : undefined,
  })

  // Look up the bot's own user/bot id once per instance via auth.test. Done in
  // authorize (per event) rather than app.init so URL verification never depends on it.
  let identity: Promise<{ botUserId: string; botId: string }> | undefined
  const app: App = new App({
    receiver,
    deferInitialization: true,
    authorize: async () => {
      identity ??= app.client.auth.test({ token: config.SLACK_BOT_TOKEN }).then(
        (res) => ({ botUserId: res.user_id!, botId: res.bot_id! }),
        (error) => {
          identity = undefined
          throw error
        },
      )
      return { botToken: config.SLACK_BOT_TOKEN, ...(await identity) }
    },
    ignoreSelf: false,
    logLevel: LogLevel.WARN,
  })

  // Bolt's default handler rethrows, which skips the ack when auth.test fails
  // (e.g. a bad SLACK_BOT_TOKEN). Log and ack instead; Slack retries are dropped anyway.
  app.error(async (error) => {
    console.error('[relay] slack error:', error.message)
  })

  const recent = new RecentIds()
  const deps = (client: unknown, context: Context): RelayDeps => ({
    client: client as SlackClient,
    self: { userId: context.botUserId!, botId: context.botId! },
    webhookUrl: config.ROUTINE_WEBHOOK_URL,
    webhookKey: config.ROUTINE_WEBHOOK_KEY,
    recent,
    fetch: fetchImpl,
  })

  // Bolt acks events before middleware runs, and the receiver runs it in waitUntil.
  async function run(envelope: Envelope, relay: () => Promise<RelayResult>) {
    try {
      const result = await relay()
      if (!result.forwarded) console.info(`[relay] skipped ${envelope.event_id}: ${result.reason}`)
    } catch (error) {
      console.error(`[relay] failed ${envelope.event_id}:`, error instanceof Error ? error.message : error)
    }
  }

  // Per-thread agent context, remembered from thread_started/context_changed. Bolt's
  // default store keeps one context per instance and edits the bot's messages.
  const contexts = new BoundedMap<AssistantContext>()
  const threadKey = (channel: string, threadTs: string) => `${channel}:${threadTs}`
  const rememberContext = (event: AssistantThreadEvent) => {
    const { channel_id, thread_ts, context } = event.assistant_thread
    if (context?.channel_id) contexts.set(threadKey(channel_id, thread_ts), context)
  }
  const onThreadEvent = async ({ body, event, client, context }: ListenerArgs) => {
    const envelope = body as Envelope
    rememberContext(event as AssistantThreadEvent)
    await run(envelope, () => relayAssistantThreadEvent(envelope, event as AssistantThreadEvent, deps(client, context)))
  }

  // Must be registered before the plain message listener: it consumes threaded DM messages.
  app.assistant(
    new Assistant({
      threadContextStore: {
        get: async ({ payload }) => {
          const msg = payload as { channel?: string; thread_ts?: string }
          return (msg.channel && msg.thread_ts && contexts.get(threadKey(msg.channel, msg.thread_ts))) || {}
        },
        save: async ({ payload }) => rememberContext(payload as AssistantThreadEvent),
      },
      threadStarted: onThreadEvent,
      threadContextChanged: onThreadEvent,
      userMessage: async ({ body, message, client, context: boltContext, getThreadContext }) => {
        const envelope = body as Envelope
        const event = message as SlackMessageEvent & { assistant_thread?: { context?: AssistantContext } }
        const threadContext = event.assistant_thread?.context ?? (await getThreadContext())
        await run(envelope, () =>
          relayEvent(envelope, event, deps(client, boltContext), {
            context: threadContext.channel_id ? threadContext : null,
          }),
        )
      },
    }),
  )

  const onEvent = async ({ body, event, client, context }: ListenerArgs) => {
    const envelope = body as Envelope
    await run(envelope, () => relayEvent(envelope, event as SlackMessageEvent, deps(client, context)))
  }
  app.event('app_mention', onEvent)
  app.event('message', onEvent)

  return createHandler(app, receiver)
}
