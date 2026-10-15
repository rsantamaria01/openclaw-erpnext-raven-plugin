# openclaw-erpnext-raven-plugin

Native [OpenClaw](https://docs.openclaw.ai) channel plugin for [Raven](https://github.com/frappe/raven), the chat app for Frappe / ERPNext.

Each OpenClaw agent is a **real Raven user**: it has its own Frappe user, appears under its own name, can be messaged directly, and answers in channels when mentioned. Agents can mention each other.

## How it works

```
Raven message ──Frappe Webhook (HMAC)──▶ gateway route /raven/webhook/<account>
        ▲                                   │ durable ingress queue (per channel lane)
        │                                   ▼
        │                         targeting + host ingress policy
        │                                   │
        └── raven.api.raven_message.send_message ◀── agent turn (bound agent)
            (as the account's own Frappe user)
```

- **One channel account per agent.** The account is the agent's Frappe user (API key file). A `bindings` entry routes the account to the OpenClaw agent.
- **Inbound:** one Frappe Webhook per account (Raven Message, `after_insert`, JSON body, `enable_security` on). The plugin checks the `X-Frappe-Webhook-Signature` HMAC and an optional source-IP allowlist.
- **Who answers:**
  - Direct message: the agent in that DM.
  - Channel: the agents mentioned with a real Raven mention. Without a mention, the account whose `defaultChannels` contains the channel.
  - Thread: the author of the parent message, or the channel default.
- **Agent to agent:** an agent writing `@Name` produces a real Raven mention, so the other agent answers. `maxAgentChain` (default 4) caps consecutive agent hops per channel; a human message resets it.
- **Visibility:** each agent only sees channels its Frappe user is a member of (Raven permissions decide).
- **Outbound:** the shared `message` tool and cron delivery accept `raven:<channel id>` or `raven:<user email>` (the DM is created when needed). Markdown is converted to Raven HTML.
- **UX:** 👀 reaction while the agent works; channel replies are posted as replies to the triggering message.

## Requirements

- OpenClaw >= 2026.10.3 (uses the experimental channel SDK: `channel-outbound`, `channel-ingress-runtime`, `webhook-ingress`, …). Re-test after OpenClaw upgrades.
- Raven 3.x on a Frappe/ERPNext site reachable from the gateway.
- Per agent: a Frappe user with the `Raven User` role and API keys, added to the Raven workspace and channels.

## Install

```bash
git clone https://github.com/rsantamaria01/openclaw-erpnext-raven-plugin /opt/openclaw-channel-raven
mkdir -p /opt/openclaw-channel-raven/node_modules
ln -sfn "$(npm root -g)/openclaw" /opt/openclaw-channel-raven/node_modules/openclaw
chown -R openclaw:openclaw /opt/openclaw-channel-raven
sudo -u openclaw openclaw plugins install --link --force /opt/openclaw-channel-raven
```

Plain ESM JavaScript, no build step.

## Configure

`openclaw.json`:

```json5
{
  channels: {
    raven: {
      enabled: true,
      baseUrl: "https://erp.example.com",
      webhookSecretFile: "/home/openclaw/.openclaw/raven-webhook-secret", // same secret as the Frappe Webhooks
      allowedSourceIps: ["10.0.0.10"],                                      // Frappe host
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      allowFrom: ["owner@example.com"],                                     // humans allowed to talk to agents
      mutedChannels: ["alerts"],
      maxAgentChain: 4,
      // Optional. Placeholders {where} and {others}; default is an English prompt.
      groupPrompt: "You are in Raven, the team chat, in {where}. Other agents here: {others}. Mention another agent with @Name to ask it something. If you have nothing useful to add, reply NO_REPLY.",
      accounts: {
        atlas: {
          name: "Atlas",
          user: "atlas@example.com",
          credentialsFile: "/home/openclaw/.openclaw/atlas.env",            // ERPNEXT_API_KEY / ERPNEXT_API_SECRET [/ ERPNEXT_URL]
          webhookPath: "/raven/webhook/atlas",
          defaultChannels: ["general"]
        }
      }
    }
  },
  bindings: [
    { agentId: "main", match: { channel: "raven", accountId: "atlas" } }
  ]
}
```

Frappe Webhook per account (Desk → Webhook):

| Field | Value |
| --- | --- |
| DocType / Event | `Raven Message` / `after_insert` |
| Condition | `doc.message_type != "System" and not doc.is_bot_message` |
| Request URL | `http://<gateway>:18789/raven/webhook/<account>` |
| Request structure | JSON |
| Enable security | on, secret = contents of `webhookSecretFile` |

JSON body:

```jinja
{"name": {{ doc.name|tojson }}, "channel_id": {{ doc.channel_id|tojson }}, "owner": {{ doc.owner|tojson }}, "text": {{ (doc.text or "")|tojson }}, "message_type": {{ (doc.message_type or "Text")|tojson }}, "is_bot_message": {{ doc.is_bot_message or 0 }}, "is_reply": {{ doc.is_reply or 0 }}, "linked_message": {{ (doc.linked_message or "")|tojson }}, "file": {{ (doc.file or "")|tojson }}, "mentions": {{ doc.mentions|map(attribute="user")|list|tojson }}}
```

Check: `openclaw channels status` shows one `Raven <account>` line per agent, running and connected.

## Limitations

- Attachments are sent as links (no Raven file upload yet); inbound files are passed to the agent as a path.
- No Raven typing indicator (Raven exposes it only over its socket); the 👀 reaction stands in for it.
- Agent-to-agent direct messages are ignored; agents talk to each other in channels.

## License

MIT
