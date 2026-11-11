import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const watchSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  repository: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  createdAt: z.string(),
  lastPollAt: z.string().nullable(),
  lastSentAt: z.string().nullable(),
  followupsSent: z.number().int(),
  status: z.enum(["watching", "closed", "uncertain", "paused"]),
  lastError: z.string().nullable(),
});

export const addWatch = defineRpc({
  name: "watch.add",
  input: z.object({ agentId: z.string().min(1), pullRequest: z.string().min(1) }),
  output: z.object({ watch: watchSchema }),
});

export const listWatches = defineRpc({
  name: "watch.list",
  input: z.object({}),
  output: z.object({ watches: z.array(watchSchema) }),
});

export const removeWatch = defineRpc({
  name: "watch.remove",
  input: z.object({ id: z.string() }),
  output: z.object({}),
});

export const resolveUncertain = defineRpc({
  name: "watch.resolve_uncertain",
  input: z.object({ id: z.string(), action: z.enum(["mark_sent", "retry"]) }),
  output: z.object({}),
});
