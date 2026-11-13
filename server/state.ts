import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const pendingSchema = z.object({
  ids: z.array(z.string()),
  prompt: z.string(),
  status: z.enum(["sending", "uncertain"]),
});

export const recordSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  workspaceId: z.string().optional(),
  repository: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  createdAt: z.string(),
  lastPollAt: z.string().nullable(),
  lastSentAt: z.string().nullable(),
  followupsSent: z.number().int().nonnegative(),
  status: z.enum(["watching", "closed", "uncertain", "paused"]),
  lastError: z.string().nullable(),
  seenIds: z.array(z.string()),
  pending: pendingSchema.nullable(),
  failures: z.number().int().nonnegative(),
  nextPollAt: z.string().nullable(),
});

export type WatchRecord = z.infer<typeof recordSchema>;
const fileSchema = z.object({ version: z.literal(1), watches: z.array(recordSchema) });

export function defaultStatePath(): string {
  if (process.env.PASEO_PR_WATCHER_STATE_FILE) return process.env.PASEO_PR_WATCHER_STATE_FILE;
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  return join(home, "plugins", "pr-watcher-state.json");
}

export class WatchStore {
  private watches: WatchRecord[] = [];

  constructor(private readonly file: string = defaultStatePath()) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, "utf8");
      this.watches = fileSchema
        .parse(JSON.parse(raw))
        .watches.map((watch) =>
          watch.pending?.status === "sending"
            ? { ...watch, status: "uncertain", pending: { ...watch.pending, status: "uncertain" } }
            : watch,
        );
      if (this.watches.some((watch) => watch.pending?.status === "uncertain")) await this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  list(): WatchRecord[] {
    return this.watches.map((watch) => structuredClone(watch));
  }

  get(id: string): WatchRecord | undefined {
    return this.watches.find((watch) => watch.id === id);
  }

  async add(watch: WatchRecord): Promise<void> {
    this.watches.push(watch);
    await this.save();
  }

  async remove(id: string): Promise<void> {
    this.watches = this.watches.filter((watch) => watch.id !== id);
    await this.save();
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, watches: this.watches }, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temp, this.file);
  }
}
