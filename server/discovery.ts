import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { parsePullRequest } from "./github.js";

const execFileAsync = promisify(execFile);

export interface CommandRunner {
  run(command: "git" | "gh", args: string[], cwd: string): Promise<string>;
}

const commands: CommandRunner = {
  async run(command, args, cwd) {
    try {
      const { stdout } = await execFileAsync(command, args, {
        cwd,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      return stdout;
    } catch {
      // Subprocess stderr can contain credential details.
      throw new Error(
        command === "gh"
          ? "Could not find pull requests. Check gh authentication and repository access."
          : "Could not read this workspace's Git checkout.",
      );
    }
  },
};

const resultSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    url: z.string(),
    title: z.string(),
    headRefName: z.string(),
    headRepository: z.object({ name: z.string() }).nullable(),
    headRepositoryOwner: z.object({ login: z.string() }).nullable(),
  }),
);
const repositorySchema = z.object({
  parent: z
    .object({ name: z.string(), owner: z.object({ login: z.string() }) })
    .nullable()
    .optional(),
});

export async function readBranch(cwd: string, runner = commands): Promise<string | null> {
  const branch = (await runner.run("git", ["branch", "--show-current"], cwd)).trim();
  return branch || null;
}

function githubRepository(url: string): string | null {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  return match?.[1] ?? null;
}

export async function discoverPullRequests(cwd: string, runner = commands) {
  const branch = await readBranch(cwd, runner);
  if (!branch) return { branch, pullRequests: [] };
  const remoteOutput = await runner.run("git", ["remote", "-v"], cwd);
  const repositories = new Set<string>();
  for (const line of remoteOutput.split("\n")) {
    const repository = githubRepository(line.split(/\s+/)[1] ?? "");
    if (repository) repositories.add(repository.toLowerCase());
  }
  if (repositories.size > 8)
    throw new Error("Too many GitHub remotes. Enter a pull request URL instead.");
  const targets = new Set(repositories);
  for (const repository of repositories) {
    const stdout = await runner.run(
      "gh",
      ["repo", "view", `github.com/${repository}`, "--json", "parent"],
      cwd,
    );
    const { parent } = repositorySchema.parse(JSON.parse(stdout));
    if (parent) targets.add(`${parent.owner.login}/${parent.name}`.toLowerCase());
  }
  const pullRequests = new Map<
    string,
    { url: string; number: number; repository: string; title: string }
  >();
  for (const repository of targets) {
    const stdout = await runner.run(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        `github.com/${repository}`,
        "--state",
        "open",
        "--head",
        branch,
        "--limit",
        "100",
        "--json",
        "number,url,title,headRefName,headRepository,headRepositoryOwner",
      ],
      cwd,
    );
    const results = resultSchema.parse(JSON.parse(stdout));
    if (results.length === 100)
      throw new Error("Too many matching pull requests. Enter a pull request URL instead.");
    for (const result of results) {
      if (result.headRefName !== branch || !result.headRepository || !result.headRepositoryOwner)
        continue;
      const head =
        `${result.headRepositoryOwner.login}/${result.headRepository.name}`.toLowerCase();
      // A fork can have the same branch name as another contributor's fork.
      if (!repositories.has(head)) continue;
      const ref = parsePullRequest(result.url);
      if (ref.number !== result.number)
        throw new Error("GitHub returned an inconsistent pull request.");
      pullRequests.set(ref.url, { ...ref, title: result.title });
    }
  }
  return { branch, pullRequests: [...pullRequests.values()] };
}
