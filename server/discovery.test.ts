import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverPullRequests, readBranch, type CommandRunner } from "./discovery.js";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), "watch-discovery-"));
  directories.push(cwd);
  await exec("git", ["init", "--initial-branch", "feature/ui", cwd]);
  await exec("git", ["-C", cwd, "remote", "add", "origin", "git@github.com:contributor/app.git"]);
  return cwd;
}

function candidate(owner: string, number: number, branch = "feature/ui") {
  return {
    number,
    title: `Change ${number}`,
    url: `https://github.com/upstream/app/pull/${number}`,
    headRefName: branch,
    headRepository: { name: "app" },
    headRepositoryOwner: { login: owner },
  };
}

class GithubRunner implements CommandRunner {
  calls: string[][] = [];
  results = [
    candidate("contributor", 12),
    candidate("other-fork", 13),
    candidate("contributor", 14, "unrelated"),
  ];
  async run(command: "git" | "gh", args: string[], cwd: string) {
    if (command === "git") return (await exec(command, args, { cwd })).stdout;
    this.calls.push(args);
    if (args[0] === "repo")
      return JSON.stringify({ parent: { name: "app", owner: { login: "upstream" } } });
    if (args[args.indexOf("--repo") + 1] === "github.com/upstream/app")
      return JSON.stringify(this.results);
    return "[]";
  }
}

it("finds the current worktree branch's PR in a fork's parent and rejects unrelated fork heads", async () => {
  const cwd = await repository();
  const runner = new GithubRunner();
  const result = await discoverPullRequests(cwd, runner);
  expect(result).toEqual({
    branch: "feature/ui",
    pullRequests: [
      {
        repository: "upstream/app",
        number: 12,
        url: "https://github.com/upstream/app/pull/12",
        title: "Change 12",
      },
    ],
  });
  expect(
    runner.calls
      .filter((args) => args[0] === "pr")
      .every((args) => args[args.indexOf("--head") + 1] === "feature/ui"),
  ).toBe(true);
  expect(
    runner.calls
      .filter((args) => args[0] === "pr")
      .every((args) => args[args.indexOf("--repo") + 1].startsWith("github.com/")),
  ).toBe(true);
});

it("deduplicates a PR found through multiple remotes and retains multiple actual candidates", async () => {
  const cwd = await repository();
  await exec("git", [
    "-C",
    cwd,
    "remote",
    "add",
    "upstream",
    "https://github.com/upstream/app.git",
  ]);
  const runner = new GithubRunner();
  runner.results = [candidate("contributor", 12), candidate("contributor", 15)];
  expect((await discoverPullRequests(cwd, runner)).pullRequests.map((pr) => pr.number)).toEqual([
    12, 15,
  ]);
  expect(runner.calls.filter((args) => args[0] === "pr")).toHaveLength(2);
});

it("does not call GitHub for a checkout with no GitHub remote", async () => {
  const cwd = await repository();
  await exec("git", ["-C", cwd, "remote", "set-url", "origin", "git@gitlab.com:team/app.git"]);
  const runner = new GithubRunner();
  expect(await discoverPullRequests(cwd, runner)).toEqual({
    branch: "feature/ui",
    pullRequests: [],
  });
  expect(runner.calls).toEqual([]);
});

it("treats a detached HEAD as a manual-only choice", async () => {
  const cwd = await repository();
  await exec("git", [
    "-C",
    cwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "Initial",
  ]);
  await exec("git", ["-C", cwd, "checkout", "--detach"]);
  const runner = new GithubRunner();
  expect(await readBranch(cwd, runner)).toBeNull();
  expect(await discoverPullRequests(cwd, runner)).toEqual({ branch: null, pullRequests: [] });
  expect(runner.calls).toEqual([]);
});

it("rejects an incomplete candidate list instead of presenting the first PR as the only match", async () => {
  const cwd = await repository();
  const runner = new GithubRunner();
  runner.results = Array.from({ length: 100 }, (_, index) => candidate("contributor", index + 1));
  await expect(discoverPullRequests(cwd, runner)).rejects.toThrow("Too many matching");
});
