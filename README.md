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
- **Shared room context:** each turn gets the last `historyLimit` channel messages (everyone, other agents included), so an agent knows what the others said.
- **Attachments:** files and images sent to an agent are downloaded (as the agent's user) and passed to it as media; files the agent sends are uploaded as real Raven attachments.
- **UX:** Raven's own "typing…" indicator while the agent works (Frappe socket.io, authenticated with the agent's API key); channel replies are posted as replies to the triggering message.

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
      historyLimit: 20,                   // recent channel messages given as context (0 = off)
      typingIndicator: true,              // Raven "typing…" while the agent works
      siteName: "erp.example.com",        // Frappe site name = socket.io namespace (default: baseUrl host)
      workingReaction: "",                // optional emoji toggled on the message while working
      mediaMaxBytes: 26214400,
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

## Chat commands (run automations on demand)

People can start an existing OpenClaw automation (cron job) from Raven by typing a command such as `/research-market`. The **plugin** decides who may run it, so a prompt cannot talk the model into it. People who may not run a command can still chat with the agent normally.

A person may run a command when any of these is true:

- they are an OpenClaw owner: `commands.ownerAllowFrom` contains `raven:<their Frappe user>` (turn off per command with `owners: false`);
- their Frappe user is listed in the command's `users`;
- their Frappe user has one of the command's `roles` (read live from Frappe, cached for 60 s; if roles cannot be read, the command is refused).

Commands only apply to people who may already talk to the agent (`allowFrom` / `dmPolicy` / `groupPolicy`), and only when the message is addressed to that account (a DM, one of its `defaultChannels`, a thread it started, or an @mention). Define them on the channel or per account; account entries are added to the channel ones.

```json5
{
  commands: { ownerAllowFrom: ["raven:owner@example.com"] },
  channels: {
    raven: {
      accounts: {
        analyst: {
          // ...
          commands: {
            prefix: "/",                 // default "/"
            help: "commands",            // "/commands" lists what the sender may run; "" turns it off
            roleCheckAccount: "",        // account whose Frappe credentials read roles (default: this account)
            cli: "openclaw",             // OpenClaw CLI used to start the automation
            messages: {                  // optional; placeholders {command} {description} {user} {minutes} {error}
              started: "Started **{description}**. The report will be posted when it finishes."
            },
            entries: {
              "research-market": {
                description: "weekly market research",
                automation: "<automation id from `openclaw cron list`>",
                roles: ["System Manager", "Marketing Manager"],
                users: [],
                aliases: ["market"],
                cooldownSeconds: 300     // ignore repeats while a run was just started
              }
            }
          }
        }
      }
    }
  }
}
```

The automation runs exactly as scheduled (same prompt, model, tools and delivery); the command only starts it now with `openclaw cron run <id>`. The account that reads roles needs read access to `Has Role` rows of users (Frappe `frappe.client.get_list` with `parent: "User"`). Command names must not clash with OpenClaw's own slash commands (`/new`, `/status`, …); unknown commands are passed to the agent unchanged.

## Notes and limitations

- Each agent keeps its own session per channel. In the OpenClaw UI an agent's channel session shows its own turns; what the other agents said reaches it as recent-history context, not as transcript rows.
- Agent media is loaded only from the agent's scoped media roots (its workspace and the host media store) or from what the host explicitly grants; arbitrary local files are refused.
- Agent-to-agent direct messages are ignored; agents talk to each other in channels.

## License

MIT
