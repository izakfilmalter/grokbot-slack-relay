# grokbot-slack-relay

Connect a Grok Bot to Slack. People DM or @mention your Slack app; a small Vercel function verifies and acks each event, filters out noise, and forwards it to a Grok Bot webhook routine. The bot then replies in Slack itself, like a teammate, using the Slack bot token.

```
Slack ──event──▶ /api/slack/events (Vercel) ──POST JSON──▶ Grok Bot routine ──chat.postMessage──▶ Slack
```

The relay only verifies, acks, filters and forwards. It never posts to Slack. It:

- verifies Slack's signature, answers `url_verification`, and acks within Slack's 3 second window (forwarding runs after the ack via `waitUntil`)
- forwards @mentions, DMs, replies in threads the bot is already in, and Slack Agents (assistant) thread events
- drops messages from bots (including itself, identified at runtime via `auth.test`), edits, deletes, joins and other non-message subtypes, Slack retries, and duplicate `event_id`s

Built with TypeScript, [`@slack/bolt`](https://docs.slack.dev/tools/bolt-js/) and [`@vercel/slack-bolt`](https://vercel.com/changelog/build-slack-agents-with-vercel-slack-bolt). Runs on the Vercel Hobby plan.

## Setup

You need a Grok Bot, a Slack workspace where you can install apps, and a Vercel account.

### 1. Create the Grok bot and a webhook routine

1. Create (or pick) the Grok bot that should answer in Slack.
2. Give it a routine that runs on a webhook, with a prompt like the [sample routine prompt](#sample-routine-prompt) below.
3. Open the bot's info pane by clicking its name in the chat header (or press Cmd+Shift+I). The Routines list is there. Open your routine: the webhook URL and sender key are shown on the routine's details. They become `ROUTINE_WEBHOOK_URL` and `ROUTINE_WEBHOOK_KEY`. The relay sends the key as `Authorization: Bearer <key>`.

### 2. Create the Slack app from the manifest

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**, pick your workspace, and paste [`manifest.template.json`](manifest.template.json). Change the name and descriptions if you like. Leave the Request URL placeholder for now (step 5).
2. The manifest sets up:
   - **Bot scopes:** `app_mentions:read`, `assistant:write`, `channels:history`, `chat:write`, `groups:history`, `im:history`, `im:read`, `reactions:write`, `users:read`. `reactions:write` is for the bot itself, so it can add and remove reactions when it chooses (`reactions.add` / `reactions.remove`); the relay never adds reactions on its own.
   - **App Home → Messages tab** enabled, so people can DM the bot
   - **Agents** (`assistant_view`), so the app gets the Slack agent/assistant container. If it isn't on after import, enable **Agents & AI Apps** in the app settings.
   - **Event subscriptions** for these bot events: `app_mention`, `message.im`, `message.channels`, `message.groups`, `assistant_thread_started`, `assistant_thread_context_changed`
3. From **Basic Information → App Credentials**, copy the **Signing Secret** (`SLACK_SIGNING_SECRET`).

### 3. Install the app and give the bot its token

1. **Install App** → install to your workspace.
2. Copy the **Bot User OAuth Token** (`xoxb-…`). This is `SLACK_BOT_TOKEN`.
3. Give the same token to your Grok bot as a bot secret (for example `SLACK_BOT_TOKEN`) so the routine can call `chat.postMessage`. The bot asks for the secret in chat; paste the token when it does.

### 4. Deploy the relay to Vercel

1. Fork or clone this repo and import it into Vercel (or run `vercel deploy --prod` from a clone).
2. In **Project → Settings → Environment Variables**, add all four for **Production** (see [`.env.example`](.env.example)):

   | Variable | Where it comes from |
   | --- | --- |
   | `SLACK_SIGNING_SECRET` | Slack app → Basic Information → Signing Secret |
   | `SLACK_BOT_TOKEN` | Slack app → OAuth & Permissions → Bot User OAuth Token |
   | `ROUTINE_WEBHOOK_URL` | webhook URL, shown on the routine's details |
   | `ROUTINE_WEBHOOK_KEY` | sender key, shown on the routine's details |

3. **Redeploy** (Deployments → ⋯ → Redeploy, or `vercel deploy --prod`). Env var changes only apply to new deployments.
4. Open `https://<your-deployment>/api/slack/events` in a browser. It should show `{"ok":true}`. If not, it lists the env var names that are missing.

### 5. Point Slack at the relay

In the Slack app → **Event Subscriptions**, set the **Request URL** to `https://<your-deployment>/api/slack/events`. Slack should show **Verified**. Save, and reinstall the app if Slack asks.

### 6. Test it

DM the bot in Slack (App Home → Messages, or the Agents panel). Your routine should run and the bot should reply. To use it in a channel, `/invite @YourBot` and @mention it there; replies in that thread reach the bot too.

## What the routine receives

Each event is a JSON `POST` with `Authorization: Bearer <ROUTINE_WEBHOOK_KEY>`:

```json
{
  "event_id": "Ev0123ABCD",
  "event_type": "app_mention",
  "kind": "mention",
  "team": "T0123ABCD",
  "channel": "C0123ABCD",
  "channel_type": "channel",
  "user": "U0123ABCD",
  "user_name": "Jane",
  "text": "<@U0BOT> can you summarize this thread?",
  "ts": "1730000000.000100",
  "thread_ts": null,
  "permalink": "https://example.slack.com/archives/C0123ABCD/p1730000000000100",
  "assistant_thread": null
}
```

`kind` tells the bot where the message came from:

| kind | Slack event | Notes |
| --- | --- | --- |
| `mention` | `app_mention` | @mention in a channel |
| `dm` | `message.im` | top-level DM |
| `thread_reply` | `message.channels` / `message.groups` | reply in a thread the bot posted or was mentioned in |
| `assistant_thread_started` | `assistant_thread_started` | user opened a new agent thread; `text` is empty |
| `assistant_thread_context_changed` | `assistant_thread_context_changed` | user switched channels with the agent panel open; `text` is empty |
| `assistant_message` | `message.im` in an agent thread | |

For the three assistant kinds, `assistant_thread` is `{ channel_id, thread_ts, context }`, where `context` is the channel the user is viewing (`{ channel_id, team_id, enterprise_id }`) when known, or `null`. For other kinds it is `null`. `user_name` and `permalink` are `null` if the lookup failed.

## Sample routine prompt

```text
You are a helpful teammate in Slack. You are triggered by a webhook whose JSON
body describes one Slack event (fields: kind, channel, user, user_name, text, ts,
thread_ts, permalink, assistant_thread).

Reply with the Slack Web API using the SLACK_BOT_TOKEN secret:
POST https://slack.com/api/chat.postMessage
Authorization: Bearer <SLACK_BOT_TOKEN>
Content-Type: application/json
{ "channel": <channel>, "thread_ts": <thread>, "text": <your reply> }

Choose <thread> by kind:
- "mention", "thread_reply": reply in the thread: thread_ts if set, otherwise ts.
- "dm": reply in the DM; use thread_ts only if it is set.
- "assistant_message": reply in the agent thread: assistant_thread.thread_ts.
  If assistant_thread.context.channel_id is set, that is the channel the user is
  looking at; use it as context if relevant.
- "assistant_thread_started": post a short greeting in assistant_thread.thread_ts
  (channel = assistant_thread.channel_id) saying what you can help with.
- "assistant_thread_context_changed": do not reply.

You may react to the message with reactions.add / reactions.remove
(channel, timestamp = ts, name) when a reaction fits better than a reply.

Address the user by user_name when natural. Keep replies concise, use Slack
mrkdwn, and never reveal tokens or keys. If the Slack API returns ok:false,
report the error instead of retrying in a loop.
```

## Troubleshooting

- **Changed an env var and nothing happened.** Vercel env vars only apply to new deployments. Redeploy.
- **Bot ignores a channel.** The bot only receives channel messages after `/invite @YourBot`, and only forwards @mentions or replies in threads it is already in.
- **Slack says the Request URL failed verification.** `SLACK_SIGNING_SECRET` is missing or wrong (GET the URL to see missing vars, then redeploy), or Vercel **Deployment Protection** is blocking Slack. Make sure your production domain is public, or use the production domain rather than a protected preview URL.
- **401 responses.** A JSON `ReceiverAuthenticityError` from the relay means the signature check failed: wrong signing secret, a request not from Slack, or a clock skew/replay. An HTML login page with 401 comes from Vercel Deployment Protection, not the relay. An unsigned `curl -X POST` returning 401 is expected.
- **500 `relay_not_configured`.** One of the four env vars is missing; the response lists which.
- **No events arriving.** Check that the Request URL shows Verified, the events above are subscribed under **Subscribe to bot events**, the app was reinstalled after scope/event changes, and the bot is in the channel. Check Vercel → Logs for `[relay] skipped …` (filtered, with the reason) or `[relay] webhook responded …` (the routine rejected it: check `ROUTINE_WEBHOOK_URL`/`ROUTINE_WEBHOOK_KEY`). `[relay] slack error: … invalid_auth` means `SLACK_BOT_TOKEN` is wrong.
- **The bot doesn't reply but the routine ran.** The bot needs the Slack bot token as a bot secret (it asks for it in chat) and the `chat:write` scope; in channels the bot must be a member.

## Development

```sh
npm install
npm test
npm run typecheck
```

Code: [`api/slack/events.ts`](api/slack/events.ts) (entry), [`src/app.ts`](src/app.ts) (Bolt wiring), [`src/filter.ts`](src/filter.ts) (what gets dropped), [`src/relay.ts`](src/relay.ts) (payload and forwarding).

Duplicate `event_id`s and agent thread context are remembered in memory per function instance, which is enough for Vercel Fluid compute but not shared across instances.

## License

[MIT](LICENSE)
