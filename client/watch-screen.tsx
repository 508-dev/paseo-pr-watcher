import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  listWatches,
  removeWatch,
  resolveUncertain,
  type watchSchema,
} from "../shared/contracts.js";
import type { z } from "zod";

type Watch = z.infer<typeof watchSchema>;

export function WatchScreen({ theme, layout }: PluginScreenProps) {
  const list = useRpc(listWatches);
  const remove = useRpc(removeWatch);
  const resolve = useRpc(resolveUncertain);
  const [watches, setWatches] = useState<Watch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await list({});
      setWatches(result.watches);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load watches.");
    } finally {
      setLoading(false);
    }
  }, [list]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  };

  const foreground = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted;
  const border = theme.colors.border;
  const padding = layout.compact ? 16 : 24;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding, gap: 12 }}
    >
      <Text style={{ color: foreground, fontSize: 20, fontWeight: "600" }}>
        Watched pull requests
      </Text>
      <Text style={{ color: muted }}>
        Use /watch-pr with a GitHub PR URL in an agent chat. New failed checks, reviews, and merge
        conflicts send that agent a follow-up.
      </Text>
      {loading ? <Text style={{ color: muted }}>Loading…</Text> : null}
      {error ? <Text style={{ color: foreground }}>{error}</Text> : null}
      {!loading && watches.length === 0 ? (
        <Text style={{ color: muted }}>No pull requests are being watched on this host.</Text>
      ) : null}
      {watches.map((watch) => (
        <View
          key={watch.id}
          style={{ borderWidth: 1, borderColor: border, borderRadius: 10, padding: 14, gap: 6 }}
        >
          <Text style={{ color: foreground, fontWeight: "600" }}>
            {watch.repository}#{watch.number}
          </Text>
          <Text style={{ color: muted }}>
            Agent {watch.agentId} · {watch.status} · {watch.followupsSent}/5 follow-ups
          </Text>
          {watch.lastPollAt ? (
            <Text style={{ color: muted }}>
              Last checked {new Date(watch.lastPollAt).toLocaleString()}
            </Text>
          ) : null}
          {watch.lastError ? <Text style={{ color: foreground }}>{watch.lastError}</Text> : null}
          {watch.status === "uncertain" ? (
            <View style={{ gap: 8, flexDirection: layout.compact ? "column" : "row" }}>
              <Action
                label="Mark handled"
                disabled={busy === watch.id}
                onPress={() =>
                  void run(watch.id, () => resolve({ id: watch.id, action: "mark_sent" }))
                }
                color={theme.colors.accent}
              />
              <Action
                label="Retry (may duplicate)"
                disabled={busy === watch.id}
                onPress={() => void run(watch.id, () => resolve({ id: watch.id, action: "retry" }))}
                color={theme.colors.accent}
              />
            </View>
          ) : null}
          <Action
            label="Remove watch"
            disabled={busy === watch.id}
            onPress={() => void run(watch.id, () => remove({ id: watch.id }))}
            color={theme.colors.accent}
          />
        </View>
      ))}
      <Action
        label="Refresh"
        disabled={loading}
        onPress={() => void refresh()}
        color={theme.colors.accent}
      />
    </ScrollView>
  );
}

function Action({
  label,
  onPress,
  disabled,
  color,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  color: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={{ paddingVertical: 8, paddingHorizontal: 4 }}
    >
      <Text style={{ color, opacity: disabled ? 0.5 : 1 }}>{label}</Text>
    </Pressable>
  );
}
