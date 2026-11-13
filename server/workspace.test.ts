import { expect, it } from "vitest";
import { validateWorkspaceWatch, type WorkspaceWatchAccess } from "./workspace.js";

const input = {
  workspaceId: "workspace-a",
  agentId: "agent-a",
  expectedBranch: "feature/ui",
  pullRequest: "owner/repo#12",
};

function access(overrides: Partial<WorkspaceWatchAccess> = {}): WorkspaceWatchAccess {
  return {
    directory: async () => "/checkout/worktree-a",
    agentWorkspace: async () => "workspace-a",
    branch: async () => "feature/ui",
    ...overrides,
  };
}

it("accepts the workspace's agent and checks its actual directory", async () => {
  let checkedDirectory = "";
  await validateWorkspaceWatch(
    input,
    access({
      branch: async (cwd) => {
        checkedDirectory = cwd;
        return "feature/ui";
      },
    }),
  );
  expect(checkedDirectory).toBe("/checkout/worktree-a");
});

it("rejects a different workspace's agent before enrolling a watch", async () => {
  await expect(
    validateWorkspaceWatch(input, access({ agentWorkspace: async () => "workspace-b" })),
  ).rejects.toThrow("active agent in this workspace");
});

it("rejects an agent removed after the picker opened", async () => {
  await expect(
    validateWorkspaceWatch(input, access({ agentWorkspace: async () => null })),
  ).rejects.toThrow("active agent in this workspace");
});

it("rejects branch changes between detection and enrollment", async () => {
  await expect(
    validateWorkspaceWatch(input, access({ branch: async () => "another-branch" })),
  ).rejects.toThrow("branch changed");
});

it("allows an explicitly entered PR URL on the same detached checkout", async () => {
  await expect(
    validateWorkspaceWatch(
      { ...input, expectedBranch: null },
      access({ branch: async () => null }),
    ),
  ).resolves.toBeUndefined();
});
