import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { expect, it, vi } from "vitest";
import { parsePullRequest, readPullRequest } from "./github.js";

it("explicitly addresses github.com when the daemon has an Enterprise GH_HOST", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-watch-gh-"));
  try {
    await writeFile(
      join(directory, "gh"),
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args[args.indexOf("--repo") + 1] !== "github.com/owner/repo") process.exit(1);
process.stdout.write(JSON.stringify({ state: "OPEN", headRefOid: "test-head", mergeStateStatus: "CLEAN" }));
`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", `${directory}${delimiter}${process.env.PATH}`);
    vi.stubEnv("GH_HOST", "enterprise.invalid");
    expect(await readPullRequest(parsePullRequest("owner/repo#1"))).toEqual({
      state: "OPEN",
      headRefOid: "test-head",
      mergeStateStatus: "CLEAN",
      checks: [],
      reviews: [],
    });
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
