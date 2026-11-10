import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { actionableEvents, followupPrompt } from "./events.js";
import {
  parsePullRequest,
  readPullRequest,
  type PullRequestRef,
  type PullRequestSnapshot,
} from "./github.js";
import { WatchStore, type WatchRecord } from "./state.js";

const pollIntervalMs = 120_000;
const sendCooldownMs = 10 * 60_000;
const maxFollowups = 5;
const maxWatches = 20;

export class Watcher {
  private paseo: PaseoApi | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: WatchStore,
    private readonly readPr: (
      ref: PullRequestRef,
    ) => Promise<PullRequestSnapshot> = readPullRequest,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(): Promise<void> {
    await this.store.load();
    this.timer = setInterval(() => void this.poll().catch(() => undefined), pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.paseo = null;
  }

  attachPaseo(paseo: PaseoApi): void {
    this.paseo = paseo;
  }

  list(): WatchRecord[] {
    return this.store.list();
  }

  add(agentId: string, input: string): Promise<WatchRecord> {
    return this.serial(async () => {
      if (this.store.list().length >= maxWatches)
        throw new Error(`Watch limit reached (${maxWatches}). Remove one first.`);
      const ref = parsePullRequest(input);
      if (
        this.store
          .list()
          .some(
            (watch) =>
              watch.agentId === agentId && watch.url === ref.url && watch.status !== "closed",
          )
      ) {
        throw new Error("This agent is already watching that pull request.");
      }
      const snapshot = await this.readPr(ref);
      if (snapshot.state !== "OPEN") throw new Error("This pull request is already closed.");
      const watch: WatchRecord = {
        id: randomUUID(),
        agentId,
        ...ref,
        createdAt: this.now().toISOString(),
        lastPollAt: this.now().toISOString(),
        lastSentAt: null,
        followupsSent: 0,
        status: "watching",
        lastError: null,
        seenIds: actionableEvents(snapshot).map((event) => event.id),
        pending: null,
        failures: 0,
        nextPollAt: null,
      };
      await this.store.add(watch);
      return structuredClone(watch);
    });
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      if (!this.store.get(id)) throw new Error("Watch not found.");
      await this.store.remove(id);
    });
  }

  resolveUncertain(id: string, action: "mark_sent" | "retry"): Promise<void> {
    return this.serial(async () => {
      const watch = this.store.get(id);
      if (!watch || watch.status !== "uncertain" || !watch.pending)
        throw new Error("No uncertain follow-up to resolve.");
      if (action === "mark_sent") {
        this.finishSend(watch);
        await this.store.save();
        return;
      }
      if (!this.paseo) throw new Error("Connect a Paseo client before retrying.");
      await this.sendPending(watch);
    });
  }

  async poll(): Promise<void> {
    if (this.polling || !this.paseo) return;
    this.polling = true;
    try {
      await this.serial(async () => {
        for (const watch of this.store.list()) {
          const current = this.store.get(watch.id);
          if (!current || current.status !== "watching") continue;
          if (current.nextPollAt && Date.parse(current.nextPollAt) > this.now().getTime()) continue;
          await this.pollOne(current);
        }
      });
    } finally {
      this.polling = false;
    }
  }

  private async pollOne(watch: WatchRecord): Promise<void> {
    if (watch.pending) {
      watch.status = "uncertain";
      watch.pending.status = "uncertain";
      watch.lastError =
        "Delivery was interrupted. Check the agent before choosing Retry or Mark handled.";
      await this.store.save();
      return;
    }
    let snapshot: PullRequestSnapshot;
    try {
      snapshot = await this.readPr(watch);
    } catch (error) {
      watch.failures += 1;
      watch.lastError = error instanceof Error ? error.message : "Could not read pull request.";
      watch.nextPollAt = new Date(
        this.now().getTime() + Math.min(pollIntervalMs * 2 ** watch.failures, 30 * 60_000),
      ).toISOString();
      await this.store.save();
      return;
    }
    watch.lastPollAt = this.now().toISOString();
    watch.failures = 0;
    watch.nextPollAt = null;
    watch.lastError = null;
    if (snapshot.state !== "OPEN") {
      watch.status = "closed";
      await this.store.save();
      return;
    }
    const seen = new Set(watch.seenIds);
    const events = actionableEvents(snapshot).filter((event) => !seen.has(event.id));
    if (events.length === 0) {
      await this.store.save();
      return;
    }
    if (watch.followupsSent >= maxFollowups) {
      watch.status = "paused";
      watch.lastError = `Reached ${maxFollowups} automatic follow-ups. Remove and add the watch to start a new cycle.`;
      await this.store.save();
      return;
    }
    if (watch.lastSentAt && this.now().getTime() - Date.parse(watch.lastSentAt) < sendCooldownMs) {
      await this.store.save();
      return;
    }
    watch.pending = {
      ids: events.map((event) => event.id),
      prompt: followupPrompt(watch.url, events),
      status: "sending",
    };
    await this.store.save();
    await this.sendPending(watch);
  }

  private async sendPending(watch: WatchRecord): Promise<void> {
    if (!watch.pending || !this.paseo) return;
    watch.pending.status = "sending";
    await this.store.save();
    try {
      // send() only confirms daemon acceptance. Never replay automatically after an ambiguous failure.
      await this.paseo.agents.ref(watch.agentId).send(watch.pending.prompt);
      this.finishSend(watch);
    } catch {
      watch.status = "uncertain";
      watch.pending.status = "uncertain";
      watch.lastError =
        "Delivery was not confirmed. Check the agent before choosing Retry or Mark handled.";
    }
    await this.store.save();
  }

  private finishSend(watch: WatchRecord): void {
    if (!watch.pending) return;
    watch.seenIds.push(...watch.pending.ids);
    watch.pending = null;
    watch.followupsSent += 1;
    watch.lastSentAt = this.now().toISOString();
    watch.status = watch.followupsSent >= maxFollowups ? "paused" : "watching";
    watch.lastError =
      watch.status === "paused"
        ? `Reached ${maxFollowups} automatic follow-ups. Remove and add the watch to start a new cycle.`
        : null;
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
