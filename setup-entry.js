import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { ravenPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(ravenPlugin);
