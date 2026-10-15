import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const store = createPluginRuntimeStore({
  pluginId: "raven",
  errorMessage: "Raven runtime not initialized - plugin not registered",
});

export const setRavenRuntime = store.setRuntime;
export const getRavenRuntime = store.getRuntime;
