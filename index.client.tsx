import type { PluginClientContext } from "@getpaseo/plugin/client";
import { WatchScreen } from "./client/watch-screen.js";
import { addWatch } from "./shared/contracts.js";
import { contributeWorkspaceControls } from "./client/workspace-controls.js";
import { watchChanged } from "./client/watch-events.js";

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
      watchChanged();
      openScreen({ screenId: "watches" });
    },
  });
  return contributeWorkspaceControls(client);
}
