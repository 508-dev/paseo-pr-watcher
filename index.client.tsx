import type { PluginClientContext } from "@getpaseo/plugin/client";
import { WatchScreen } from "./client/watch-screen.js";
import { addWatch, listWatches } from "./shared/contracts.js";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "watches", title: "PR watcher", Component: WatchScreen });
  client.addCommandCenterItem({
    id: "open-watches",
    title: "Watched pull requests",
    icon: "GitPullRequest",
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "watches" });
    },
  });
  client.addSlashCommand({
    name: "watch-pr",
    description: "Watch a GitHub PR for checks, reviews, and conflicts",
    argumentHint: "<URL or owner/repo#number>",
    context: "agent",
    async onSubmit({ args, agent, rpc, openScreen }) {
      await rpc(addWatch, { agentId: agent.id, pullRequest: args });
      openScreen({ screenId: "watches" });
    },
  });
  // The server API becomes available on connection; this also resumes polling after a daemon restart.
  void client.rpc(listWatches, {}).catch(() => undefined);
  return () => {};
}
