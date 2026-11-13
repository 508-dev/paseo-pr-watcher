import type {
  PluginButton,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import type { PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import type { z } from "zod";
import { listWatches, type watchSchema } from "../shared/contracts.js";
import { createWatchPopover } from "./watch-popover.js";
import { onWatchChanged } from "./watch-events.js";

type Watch = z.infer<typeof watchSchema>;

function watchButton(
  watches: Watch[],
  Content: ReturnType<typeof createWatchPopover>,
): PluginButton {
  const active = watches.filter((watch) => watch.status !== "closed");
  const urls = new Set(active.map((watch) => watch.url));
  let label = "Watch PR";
  if (urls.size === 1) {
    const watch = active[0];
    label = `Watching #${watch.number}`;
    if (active.every((item) => item.status === "paused")) label = `Watch paused · #${watch.number}`;
    if (active.some((item) => item.status === "uncertain"))
      label = `Review delivery · #${watch.number}`;
  }
  if (urls.size > 1) label = `Watching ${urls.size} PRs`;
  return {
    title: label,
    label,
    icon: "GitPullRequest",
    behavior: { kind: "popover", Content },
  };
}

export function contributeWorkspaceControls(client: PluginClientContext) {
  const Content = createWatchPopover(client);
  const headers = new Map<string, PluginButtonRegistration>();
  const pills = new Map<string, PluginButtonRegistration>();
  const agents = new Map<string, PaseoAgent>();
  let watches: Watch[] = [];
  let stopped = false;
  let refreshing = false;
  const cleanups: Array<() => void> = [];
  const lifetime = new AbortController();
  let workspaceSnapshot = 0;
  let agentSnapshot = 0;

  async function remainingWorkspaces(cursor: string | null, generation: number) {
    while (cursor && !stopped && generation === workspaceSnapshot) {
      const result = await client.paseo.workspaces.list({ page: { limit: 200, cursor } });
      if (stopped || generation !== workspaceSnapshot) return;
      for (const workspace of result.entries) registerWorkspace(workspace);
      cursor = result.pageInfo.nextCursor;
    }
  }
  async function remainingAgents(cursor: string | null, generation: number) {
    while (cursor && !stopped && generation === agentSnapshot) {
      const result = await client.paseo.agents.list({
        signal: lifetime.signal,
        page: { limit: 200, cursor },
      });
      if (stopped || generation !== agentSnapshot) return;
      for (const { agent } of result.entries) registerAgent(agent);
      cursor = result.pageInfo.nextCursor;
    }
  }

  function workspaceWatches(workspaceId: string) {
    return watches.filter(
      (watch) => (watch.workspaceId ?? agents.get(watch.agentId)?.workspaceId) === workspaceId,
    );
  }
  function updateButtons() {
    for (const [id, header] of headers) header.update(watchButton(workspaceWatches(id), Content));
    for (const [id, pill] of pills)
      pill.update(
        watchButton(
          watches.filter((watch) => watch.agentId === id),
          Content,
        ),
      );
  }
  function registerWorkspace(workspace: PaseoWorkspace) {
    if (stopped || workspace.projectKind !== "git") return;
    if (!headers.has(workspace.id)) {
      headers.set(
        workspace.id,
        client.addHeaderButton({
          id: "watch-pr",
          workspaceId: workspace.id,
          button: watchButton(workspaceWatches(workspace.id), Content),
        }),
      );
    }
  }
  function registerAgent(agent: PaseoAgent) {
    if (stopped) return;
    if (agent.archivedAt || agent.status === "closed") {
      removeAgent(agent.id);
      return;
    }
    if (agents.get(agent.id)?.workspaceId !== agent.workspaceId) {
      pills.get(agent.id)?.remove();
      pills.delete(agent.id);
    }
    agents.set(agent.id, agent);
    if (agent.workspaceId && !agent.archivedAt && !pills.has(agent.id)) {
      pills.set(
        agent.id,
        client.addComposerPill({
          id: "watch-pr",
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          button: watchButton(
            watches.filter((watch) => watch.agentId === agent.id),
            Content,
          ),
        }),
      );
    }
    updateButtons();
  }
  function removeAgent(id: string) {
    pills.get(id)?.remove();
    pills.delete(id);
    agents.delete(id);
    updateButtons();
  }
  async function refreshWatches() {
    if (refreshing || stopped) return;
    refreshing = true;
    try {
      const result = await client.rpc(listWatches, {});
      if (stopped) return;
      watches = result.watches;
      updateButtons();
    } catch {
      if (!stopped) {
        for (const button of [...headers.values(), ...pills.values()]) {
          button.update({ title: "PR watch status unavailable", label: "PR watch unavailable" });
        }
      }
    } finally {
      refreshing = false;
    }
  }

  void client.paseo.workspaces
    .list({ subscribe: {}, page: { limit: 200 } })
    .then(({ subscription }) => {
      if (stopped) {
        void subscription.release();
        return;
      }
      const unsubscribe = subscription.subscribe({
        snapshot: ({ entries, pageInfo }) => {
          for (const workspace of entries) registerWorkspace(workspace);
          void remainingWorkspaces(pageInfo.nextCursor, ++workspaceSnapshot).catch(() => {
            if (!stopped)
              console.error(
                "PR watcher could not load the remaining workspaces. Reconnect to retry.",
              );
          });
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "upsert") registerWorkspace(update.workspace);
          else {
            headers.get(update.id)?.remove();
            headers.delete(update.id);
          }
        },
        error: () => {
          console.error("PR watcher could not observe workspaces. Reconnect this host to retry.");
        },
      });
      cleanups.push(() => {
        unsubscribe();
        void subscription.release();
      });
    })
    .catch(() => {
      if (!stopped)
        console.error("PR watcher could not load workspaces. Reconnect this host to retry.");
    });
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal, page: { limit: 200 } })
    .then(({ subscription }) => {
      if (stopped) {
        void subscription.release();
        return;
      }
      const unsubscribe = subscription.subscribe({
        snapshot: ({ entries, pageInfo }) => {
          for (const id of pills.keys()) removeAgent(id);
          for (const { agent } of entries) registerAgent(agent);
          void remainingAgents(pageInfo.nextCursor, ++agentSnapshot).catch(() => {
            if (!stopped)
              console.error("PR watcher could not load the remaining agents. Reconnect to retry.");
          });
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") removeAgent(update.agentId);
          else registerAgent(update.agent);
        },
        error: () => {
          console.error("PR watcher could not observe agents. Reconnect this host to retry.");
        },
      });
      cleanups.push(() => {
        unsubscribe();
        void subscription.release();
      });
    })
    .catch(() => {
      if (!stopped)
        console.error("PR watcher could not load agents. Reconnect this host to retry.");
    });
  void refreshWatches();
  const timer = setInterval(() => void refreshWatches(), 30_000);
  const removeListener = onWatchChanged(() => void refreshWatches());
  return () => {
    stopped = true;
    lifetime.abort();
    clearInterval(timer);
    removeListener();
    for (const cleanup of cleanups) cleanup();
    for (const button of [...headers.values(), ...pills.values()]) button.remove();
    headers.clear();
    pills.clear();
    agents.clear();
  };
}
