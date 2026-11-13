import {
  useAgent,
  useAgents,
  useComposers,
  useRpc,
  useWorkspace,
  type PluginButtonContentProps,
  type PluginHostProps,
  type PluginClientContext,
} from "@getpaseo/plugin/client";
import { ExternalLink, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import {
  addWorkspaceWatch,
  discoverWorkspace,
  listWatches,
  removeWatch,
  resolveUncertain,
  type watchSchema,
} from "../shared/contracts.js";
import { onWatchChanged, watchChanged } from "./watch-events.js";

type Watch = z.infer<typeof watchSchema>;

type WatchPopoverProps = PluginButtonContentProps & { preferredAgentId?: string };

export function createWatchPopover(client: Pick<PluginClientContext, "composers">) {
  return function FocusedWatchPopover(props: PluginButtonContentProps) {
    const focused = useComposers({ focused: true })[0];
    const refs = useAgents({
      hosts: [props.host.id],
      where: (agent) => agent.workspaceId === props.workspaceId,
    });
    // Both selectors resolve the same host-owned composer handle.
    const preferred = refs.find((ref) => client.composers({ agentId: ref.id }).includes(focused));
    return <WatchPopover {...props} preferredAgentId={preferred?.id} />;
  };
}

export function WatchPopover(props: WatchPopoverProps) {
  return <WorkspaceWatchForm key={props.workspaceId} {...props} />;
}

function WorkspaceWatchForm(props: WatchPopoverProps) {
  const { workspaceId, host, theme, layout } = props;
  const workspace = useWorkspace(workspaceId, ({ name, branch }) => ({ name, branch }));
  const agentRefs = useAgents({
    hosts: [host.id],
    where: (agent) => agent.workspaceId === workspaceId && agent.status !== "closed",
  });
  const detect = useRpc(discoverWorkspace);
  const list = useRpc(listWatches);
  const add = useRpc(addWorkspaceWatch);
  const remove = useRpc(removeWatch);
  const resolve = useRpc(resolveUncertain);
  const queryClient = useQueryClient();
  const discoveryQuery = useQuery({
    queryKey: ["pr-discovery", host.id, workspaceId, workspace?.branch],
    queryFn: () => detect({ workspaceId }),
    retry: false,
    staleTime: 30_000,
  });
  const watchesQuery = useQuery({
    queryKey: ["pr-watches", host.id],
    queryFn: () => list({}),
    retry: false,
    refetchInterval: 30_000,
  });
  const mutation = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => {
      await action();
      watchChanged();
      await queryClient.invalidateQueries({ queryKey: ["pr-watches", host.id] });
    },
  });
  const discovery = discoveryQuery.data ?? null;
  const watches = watchesQuery.data?.watches ?? [];
  const loading = discoveryQuery.isFetching;
  const busy = mutation.isPending;
  const error = mutation.error ?? discoveryQuery.error ?? watchesQuery.error;
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedPr, setSelectedPr] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [setupRequested, setSetupRequested] = useState(false);
  const [url, setUrl] = useState("");
  const currentAgent = props.context === "agent" ? props.agentId : null;
  const agentId =
    selectedAgent ??
    currentAgent ??
    props.preferredAgentId ??
    (agentRefs.length === 1 ? agentRefs[0].id : null);
  const eligibleAgent = agentRefs.some((ref) => ref.id === agentId);
  const candidates = discovery?.pullRequests ?? [];
  const selectedCandidate = candidates.find((pr) => pr.url === selectedPr);
  const detectedUrl =
    selectedCandidate?.url ?? (candidates.length === 1 ? candidates[0].url : null);
  const pullRequest = manual ? url.trim() : detectedUrl;
  const workspaceWatches = watches.filter((watch) =>
    watch.workspaceId
      ? watch.workspaceId === workspaceId
      : agentRefs.some((ref) => ref.id === watch.agentId),
  );
  const configuring = setupRequested || workspaceWatches.length === 0;
  const alreadyWatching = workspaceWatches.some(
    (watch) => watch.agentId === agentId && watch.url === pullRequest && watch.status !== "closed",
  );

  useEffect(
    () =>
      onWatchChanged(() => {
        void queryClient.invalidateQueries({ queryKey: ["pr-watches", host.id] });
      }),
    [queryClient, host.id],
  );

  function run(action: () => Promise<unknown>) {
    mutation.mutate(action);
  }
  function refresh() {
    mutation.reset();
    void discoveryQuery.refetch();
    void watchesQuery.refetch();
  }

  const foreground = { color: theme.colors.foreground };
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  const activeSelection = {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
  };
  const selectionStyle = {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    padding: 12,
    gap: 4,
  };

  return (
    <ScrollView
      style={{ maxHeight: layout.compact ? undefined : 560, width: layout.compact ? "100%" : 380 }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
      testID="workspace-pr-watcher"
    >
      <Text style={{ ...foreground, fontSize: 16, fontWeight: "600" }}>PR watcher</Text>
      <Text style={muted}>
        {workspace?.name} · {discovery?.branch ?? workspace?.branch ?? "Detached HEAD"}
      </Text>
      <Text style={muted}>
        Send an agent follow-ups for new failing checks, reviews, and merge conflicts. Watching
        never merges the PR.
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
          {error.message}
        </Text>
      ) : null}
      {loading ? <Text style={muted}>Finding pull requests…</Text> : null}
      {workspaceWatches.map((watch) => (
        <WatchDetails
          key={watch.id}
          watch={watch}
          theme={theme}
          busy={busy}
          onRemove={() => void run(() => remove({ id: watch.id }))}
          onResolve={(action) => void run(() => resolve({ id: watch.id, action }))}
        />
      ))}
      {workspaceWatches.length > 0 && !configuring ? (
        <WatchAction
          theme={theme}
          label="Watch another PR or agent"
          disabled={busy}
          onPress={() => setSetupRequested(true)}
        />
      ) : null}
      {configuring && !loading && discovery ? (
        <>
          {discovery.error ? (
            <Text style={{ color: theme.colors.statusWarning }}>{discovery.error}</Text>
          ) : null}
          {!manual && candidates.length === 0 ? (
            <Text style={muted}>
              No open pull request found for this branch. Create a PR first, or enter its URL below.
            </Text>
          ) : null}
          {!manual
            ? candidates.map((pr) => (
                <Pressable
                  key={pr.url}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: detectedUrl === pr.url }}
                  accessibilityLabel={`${pr.repository}#${pr.number}: ${pr.title}`}
                  disabled={busy}
                  onPress={() => setSelectedPr(pr.url)}
                  style={[selectionStyle, detectedUrl === pr.url ? activeSelection : null]}
                >
                  <Text style={{ ...foreground, fontWeight: "600" }}>
                    {pr.repository}#{pr.number}
                  </Text>
                  <Text style={muted}>{pr.title}</Text>
                </Pressable>
              ))
            : null}
          <WatchAction
            theme={theme}
            label={manual ? "Use detected pull requests" : "Enter a PR URL instead"}
            disabled={busy}
            onPress={() => setManual(!manual)}
          />
          {manual ? (
            <TextInput
              accessibilityLabel="GitHub pull request URL"
              placeholder="https://github.com/owner/repo/pull/123"
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              value={url}
              onChangeText={setUrl}
              editable={!busy}
              style={{
                ...foreground,
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: 8,
                padding: 12,
              }}
            />
          ) : null}
          <Text style={{ ...foreground, fontWeight: "600" }}>Send follow-ups to</Text>
          {agentRefs.length === 0 ? (
            <Text style={muted}>Open an agent in this workspace to start watching.</Text>
          ) : null}
          {agentRefs.map((ref) => (
            <AgentChoice
              key={ref.key}
              id={ref.id}
              selected={agentId === ref.id}
              disabled={busy}
              onSelect={setSelectedAgent}
              theme={theme}
            />
          ))}
          <WatchAction
            theme={theme}
            primary
            label={
              busy ? "Updating…" : alreadyWatching ? "Already watching for this agent" : "Watch PR"
            }
            disabled={busy || !eligibleAgent || !pullRequest || alreadyWatching}
            onPress={() => {
              if (!agentId || !pullRequest) return;
              void run(async () => {
                await add({ workspaceId, agentId, pullRequest, expectedBranch: discovery.branch });
                setSetupRequested(false);
              });
            }}
          />
          <Text style={muted}>
            Checks every 2 minutes. At least 10 minutes between follow-ups; pauses after 5. Existing
            events form the starting baseline.
          </Text>
        </>
      ) : null}

      <WatchAction
        theme={theme}
        label="Refresh"
        disabled={busy || loading}
        onPress={() => void refresh()}
      />
    </ScrollView>
  );
}

function AgentChoice({
  id,
  selected,
  disabled,
  onSelect,
  theme,
}: {
  id: string;
  selected: boolean;
  disabled: boolean;
  onSelect(id: string): void;
  theme: PluginHostProps["theme"];
}) {
  const agent = useAgent(id, ({ title, provider }) => ({ title, provider }));
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      disabled={disabled}
      onPress={() => onSelect(id)}
      style={{
        padding: 12,
        borderRadius: 8,
        backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface0,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
      }}
    >
      <Text style={{ color: theme.colors.foreground }}>
        {agent?.title ?? `Agent ${id.slice(0, 8)}`}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{agent?.provider}</Text>
    </Pressable>
  );
}

function WatchDetails({
  watch,
  theme,
  busy,
  onRemove,
  onResolve,
}: {
  watch: Watch;
  theme: PluginHostProps["theme"];
  busy: boolean;
  onRemove(): void;
  onResolve(action: "mark_sent" | "retry"): void;
}) {
  const agent = useAgent(watch.agentId, ({ title }) => title);
  return (
    <View style={{ gap: 8, borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 12 }}>
      <ExternalLink href={watch.url}>
        {watch.repository}#{watch.number}
      </ExternalLink>
      <Text style={{ color: theme.colors.foreground }}>
        {watch.status === "watching" ? "Watching" : watch.status} ·{" "}
        {agent ?? watch.agentId.slice(0, 8)}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>
        {watch.followupsSent}/5 follow-ups sent
      </Text>
      {watch.lastPollAt ? (
        <Text style={{ color: theme.colors.foregroundMuted }}>
          Last checked {new Date(watch.lastPollAt).toLocaleString()}
        </Text>
      ) : null}
      {watch.lastSentAt ? (
        <Text style={{ color: theme.colors.foregroundMuted }}>
          Last follow-up {new Date(watch.lastSentAt).toLocaleString()}
        </Text>
      ) : null}
      {watch.lastError ? (
        <Text style={{ color: theme.colors.statusWarning }}>{watch.lastError}</Text>
      ) : null}
      {watch.status === "uncertain" ? (
        <>
          <WatchAction
            theme={theme}
            label="Mark handled"
            disabled={busy}
            onPress={() => onResolve("mark_sent")}
          />
          <WatchAction
            theme={theme}
            label="Retry (may duplicate)"
            disabled={busy}
            onPress={() => onResolve("retry")}
          />
        </>
      ) : null}
      <WatchAction theme={theme} label="Stop watching" disabled={busy} onPress={onRemove} />
    </View>
  );
}

export function WatchAction({
  theme,
  label,
  disabled,
  onPress,
  primary = false,
}: {
  theme: PluginHostProps["theme"];
  label: string;
  disabled: boolean;
  onPress(): void;
  primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: 44,
        justifyContent: "center",
        paddingHorizontal: 12,
        borderRadius: 8,
        opacity: disabled ? 0.5 : 1,
        backgroundColor: primary ? theme.colors.accent : theme.colors.surface1,
      }}
    >
      <Text style={{ color: primary ? theme.colors.accentForeground : theme.colors.foreground }}>
        {label}
      </Text>
    </Pressable>
  );
}
