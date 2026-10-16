import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { ravenPlugin } from "./src/channel.js";
import { setRavenRuntime } from "./src/runtime.js";
import { createTasksTool, TASKS_TOOL_NAME } from "./src/tasks.js";

export default defineChannelPluginEntry({
  id: "raven",
  name: "Raven",
  description: "Raven (Frappe chat) channel plugin: each OpenClaw agent is a real Raven user.",
  plugin: ravenPlugin,
  setRuntime: setRavenRuntime,
  registerFull(api) {
    // Agent tool: list / start the agent's predetermined tasks (its marked automations),
    // with permission checked against the real Raven sender's owner bit, user list or Frappe roles.
    api.registerTool((ctx) => createTasksTool(ctx, api.logger), { name: TASKS_TOOL_NAME });
  },
});
