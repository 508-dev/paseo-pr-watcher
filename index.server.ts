import type { PluginServerContext } from "@getpaseo/plugin/server";
import { WatchStore } from "./server/state.js";
import { Watcher } from "./server/watcher.js";
import { addWatch, listWatches, removeWatch, resolveUncertain } from "./shared/contracts.js";

export default function contribute(server: PluginServerContext) {
  const watcher = new Watcher(new WatchStore());
  const ready = watcher.start();
  // Observe startup immediately; RPC handlers still await the original rejection.
  void ready.catch(() =>
    console.error("PR watcher could not load its state file. Restore it and reload the plugin."),
  );

  server.handle(addWatch, async ({ agentId, pullRequest }, { paseo }) => {
    await ready;
    watcher.attachPaseo(paseo);
    const watch = await watcher.add(agentId, pullRequest);
    return { watch };
  });
  server.handle(listWatches, async (_input, { paseo }) => {
    await ready;
    watcher.attachPaseo(paseo);
    return { watches: watcher.list() };
  });
  server.handle(removeWatch, async ({ id }, { paseo }) => {
    await ready;
    watcher.attachPaseo(paseo);
    await watcher.remove(id);
    return {};
  });
  server.handle(resolveUncertain, async ({ id, action }, { paseo }) => {
    await ready;
    watcher.attachPaseo(paseo);
    await watcher.resolveUncertain(id, action);
    return {};
  });

  return () => watcher.stop();
}
