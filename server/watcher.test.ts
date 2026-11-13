import type { PaseoApi } from "@getpaseo/client";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actionableEvents } from "./events.js";
import { parsePullRequest, type PullRequestSnapshot } from "./github.js";
import { WatchStore } from "./state.js";
import { Watcher } from "./watcher.js";

const base: PullRequestSnapshot = {
  state: "OPEN",
  headRefOid: "abc123",
  mergeStateStatus: "CLEAN",
  checks: [],
  reviews: [],
};

describe("GitHub watch events", () => {
  it("accepts a GitHub PR URL or shorthand and rejects other hosts", () => {
    expect(parsePullRequest("https://github.com/508-dev/paseo/pull/42/files")).toEqual({
      repository: "508-dev/paseo",
      number: 42,
      url: "https://github.com/508-dev/paseo/pull/42",
    });
    expect(parsePullRequest("508-dev/paseo#42").number).toBe(42);
    expect(() => parsePullRequest("https://example.com/508-dev/paseo/pull/42")).toThrow();
  });

  it("only reports actionable checks, submitted reviews, and conflicts", () => {
    const events = actionableEvents({
      ...base,
      mergeStateStatus: "DIRTY",
      checks: [
        {
          name: "build",
          conclusion: "FAILURE",
          completedAt: "2026-11-11T00:00:00Z",
          detailsUrl: null,
        },
        {
          name: "lint",
          conclusion: "SUCCESS",
          completedAt: "2026-11-11T00:00:00Z",
          detailsUrl: null,
        },
      ],
      reviews: [
        {
          id: "r1",
          state: "CHANGES_REQUESTED",
          author: "reviewer",
          body: "Fix this",
          submittedAt: "2026-11-11T00:00:00Z",
        },
      ],
    });
    expect(events.map(({ id }) => id)).toEqual([
      "check:abc123:build:2026-11-11T00:00:00Z",
      "review:r1",
      "conflict:abc123",
    ]);
  });
});

describe("watcher lifecycle", () => {
  it("does not leave a polling timer when stopped during state loading", async () => {
    let completeLoad!: () => void;
    const store = new WatchStore();
    vi.spyOn(store, "load").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          completeLoad = resolve;
        }),
    );
    vi.useFakeTimers();
    try {
      const watcher = new Watcher(store);
      const ready = watcher.start();
      watcher.stop();
      completeLoad();
      await ready;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("watcher delivery", () => {
  let directory: string;
  let file: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "paseo-pr-watcher-test-"));
    file = join(directory, "state.json");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("retains workspace ownership after reload while accepting older agent-only watches", async () => {
    const watcher = new Watcher(new WatchStore(file), async () => base);
    await watcher.start();
    try {
      await watcher.add("agent-1", "owner/repo#12", { workspaceId: "workspace-a" });
      await watcher.add("agent-2", "owner/repo#13");
      const restored = new WatchStore(file);
      await restored.load();
      expect(restored.list()[0].workspaceId).toBe("workspace-a");
      expect(restored.list()[1].workspaceId).toBeUndefined();
    } finally {
      watcher.stop();
    }
  });

  it("baselines existing failures, sends new failures once, and persists the cursor", async () => {
    let snapshot: PullRequestSnapshot = {
      ...base,
      checks: [{ name: "old", conclusion: "FAILURE", completedAt: "t0", detailsUrl: null }],
    };
    const send = vi.fn(async (_text: string) => undefined);
    const paseo = { agents: { ref: () => ({ send }) } } as unknown as PaseoApi;
    const watcher = new Watcher(new WatchStore(file), async () => snapshot);
    await watcher.start();
    watcher.attachPaseo(paseo);
    await watcher.add("agent-1", "owner/repo#12");
    await watcher.poll();
    expect(send).not.toHaveBeenCalled();

    snapshot = {
      ...snapshot,
      checks: [
        ...snapshot.checks,
        {
          name: "new",
          conclusion: "FAILURE",
          completedAt: "t1",
          detailsUrl: "https://github.com/check",
        },
      ],
    };
    await watcher.poll();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toContain("Check new failure");
    await watcher.poll();
    expect(send).toHaveBeenCalledTimes(1);
    expect(watcher.list()[0]).toMatchObject({
      status: "watching",
      followupsSent: 1,
      pending: null,
    });
    expect(JSON.parse(await readFile(file, "utf8")).watches[0].seenIds).toContain(
      "check:abc123:new:t1",
    );
    watcher.stop();
  });

  it("reports legacy CI errors", () => {
    expect(
      actionableEvents({
        ...base,
        checks: [{ name: "external-ci", conclusion: "ERROR", completedAt: null, detailsUrl: null }],
      }),
    ).toEqual([{ id: "check:abc123:external-ci:ERROR", line: "Check external-ci error." }]);
  });

  it("reports a new conflict after a clean poll on the same head", async () => {
    let snapshot = { ...base, mergeStateStatus: "DIRTY" };
    const send = vi.fn(async () => undefined);
    const watcher = new Watcher(new WatchStore(file), async () => snapshot);
    await watcher.start();
    watcher.attachPaseo({ agents: { ref: () => ({ send }) } } as unknown as PaseoApi);
    try {
      await watcher.add("agent-1", "owner/repo#12");
      await watcher.poll();
      expect(send).not.toHaveBeenCalled();
      snapshot = { ...base, mergeStateStatus: "CLEAN" };
      await watcher.poll();
      snapshot = { ...base, mergeStateStatus: "DIRTY" };
      await watcher.poll();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]).toEqual([expect.stringContaining("merge conflict")]);
    } finally {
      watcher.stop();
    }
  });

  it("does not resend after an ambiguous failure or a restart", async () => {
    let snapshot: PullRequestSnapshot = base;
    const send = vi.fn(async () => {
      throw new Error("connection lost after acceptance");
    });
    const paseo = { agents: { ref: () => ({ send }) } } as unknown as PaseoApi;
    const watcher = new Watcher(new WatchStore(file), async () => snapshot);
    await watcher.start();
    watcher.attachPaseo(paseo);
    await watcher.add("agent-1", "owner/repo#12");
    snapshot = { ...base, mergeStateStatus: "DIRTY" };
    await watcher.poll();
    expect(watcher.list()[0]).toMatchObject({ status: "uncertain", followupsSent: 0 });
    await watcher.poll();
    expect(send).toHaveBeenCalledTimes(1);
    watcher.stop();

    const restarted = new Watcher(new WatchStore(file), async () => snapshot);
    await restarted.start();
    restarted.attachPaseo(paseo);
    await restarted.poll();
    expect(send).toHaveBeenCalledTimes(1);
    const id = restarted.list()[0]!.id;
    await restarted.resolveUncertain(id, "mark_sent");
    expect(restarted.list()[0]).toMatchObject({ status: "watching", followupsSent: 1 });
    restarted.stop();
  });

  it("pauses after five follow-ups and backs off GitHub errors", async () => {
    let current = new Date("2026-11-11T00:00:00Z");
    let snapshot: PullRequestSnapshot = base;
    let fail = false;
    const send = vi.fn(async () => undefined);
    const paseo = { agents: { ref: () => ({ send }) } } as unknown as PaseoApi;
    const watcher = new Watcher(
      new WatchStore(file),
      async () => {
        if (fail) throw new Error("GitHub unavailable");
        return snapshot;
      },
      () => current,
    );
    await watcher.start();
    watcher.attachPaseo(paseo);
    await watcher.add("agent-1", "owner/repo#12");
    for (let index = 1; index <= 5; index++) {
      current = new Date(current.getTime() + 11 * 60_000);
      snapshot = { ...base, headRefOid: `head-${index}`, mergeStateStatus: "DIRTY" };
      await watcher.poll();
    }
    expect(send).toHaveBeenCalledTimes(5);
    current = new Date(current.getTime() + 11 * 60_000);
    snapshot = { ...base, headRefOid: "head-6", mergeStateStatus: "DIRTY" };
    await watcher.poll();
    expect(watcher.list()[0]).toMatchObject({ status: "paused", followupsSent: 5 });

    // A separate watch remains active and backs off without sending on a GitHub error.
    await watcher.add("agent-2", "owner/repo#13");
    fail = true;
    await watcher.poll();
    const second = watcher.list().find((watch) => watch.agentId === "agent-2")!;
    expect(second.failures).toBe(1);
    expect(Date.parse(second.nextPollAt!)).toBeGreaterThan(current.getTime());
    watcher.stop();
  });
});
