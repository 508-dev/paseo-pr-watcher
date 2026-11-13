import type { PaseoApi } from "@getpaseo/client";
import { readBranch } from "./discovery.js";

export async function workspaceDirectory(paseo: PaseoApi, workspaceId: string) {
  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  if (!workspace) throw new Error("This workspace is no longer available.");
  return workspace.workspaceDirectory ?? workspace.projectRootPath;
}

interface WorkspaceWatchInput {
  workspaceId: string;
  agentId: string;
  expectedBranch: string | null;
  pullRequest: string;
}

export interface WorkspaceWatchAccess {
  directory(workspaceId: string): Promise<string>;
  agentWorkspace(agentId: string): Promise<string | null>;
  branch(cwd: string): Promise<string | null>;
}

export function workspaceWatchAccess(paseo: PaseoApi): WorkspaceWatchAccess {
  return {
    directory: (id) => workspaceDirectory(paseo, id),
    async agentWorkspace(id) {
      const result = await paseo.agents.ref(id).refresh();
      if (!result || result.agent.archivedAt || result.agent.status === "closed") return null;
      return result.agent.workspaceId ?? null;
    },
    branch: readBranch,
  };
}

export async function validateWorkspaceWatch(
  input: WorkspaceWatchInput,
  access: WorkspaceWatchAccess,
) {
  const cwd = await access.directory(input.workspaceId);
  if ((await access.agentWorkspace(input.agentId)) !== input.workspaceId) {
    throw new Error("Choose an active agent in this workspace.");
  }
  if ((await access.branch(cwd)) !== input.expectedBranch) {
    throw new Error("The workspace branch changed. Refresh and choose its pull request again.");
  }
}
