import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { ravenPlugin } from "./src/channel.js";
import { setRavenRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "raven",
  name: "Raven",
  description: "Raven (Frappe chat) channel plugin: each OpenClaw agent is a real Raven user.",
  plugin: ravenPlugin,
  setRuntime: setRavenRuntime,
});
