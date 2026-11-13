import type { PluginServerContext } from "@getpaseo/plugin/server";
import { WatchStore } from "./server/state.js";
import { Watcher } from "./server/watcher.js";
import {
  addWatch,
  addWorkspaceWatch,
  discoverWorkspace,
  listWatches,
  removeWatch,
  resolveUncertain,
} from "./shared/contracts.js";
import { discoverPullRequests, readBranch } from "./server/discovery.js";
import {
  workspaceDirectory,
  validateWorkspaceWatch,
  workspaceWatchAccess,
} from "./server/workspace.js";

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
  server.handle(discoverWorkspace, async ({ workspaceId }, { paseo }) => {
    const cwd = await workspaceDirectory(paseo, workspaceId);
    const branch = await readBranch(cwd);
    try {
      return { ...(await discoverPullRequests(cwd)), error: null };
    } catch {
      return {
        branch,
        pullRequests: [],
        error: "Could not detect pull requests. Check gh access, retry, or enter a GitHub PR URL.",
      };
    }
  });
  server.handle(addWorkspaceWatch, async (input, { paseo }) => {
    await ready;
    await validateWorkspaceWatch(input, workspaceWatchAccess(paseo));
    watcher.attachPaseo(paseo);
    return {
      watch: await watcher.add(input.agentId, input.pullRequest, {
        workspaceId: input.workspaceId,
      }),
    };
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
