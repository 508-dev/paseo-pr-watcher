import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Check {
  name: string;
  conclusion: string | null;
  completedAt: string | null;
  detailsUrl: string | null;
}

export interface Review {
  id: string;
  state: string;
  author: string;
  body: string;
  submittedAt: string;
}

export interface PullRequestSnapshot {
  state: string;
  headRefOid: string;
  mergeStateStatus: string;
  checks: Check[];
  reviews: Review[];
}

export interface PullRequestRef {
  repository: string;
  number: number;
  url: string;
}

export function parsePullRequest(input: string): PullRequestRef {
  const trimmed = input.trim();
  const urlMatch =
    /^https:\/\/github\.com\/([a-z\d_.-]+)\/([a-z\d_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(trimmed);
  const shorthandMatch = /^([a-z\d_.-]+)\/([a-z\d_.-]+)#(\d+)$/i.exec(trimmed);
  const match = urlMatch ?? shorthandMatch;
  if (!match) throw new Error("Enter a GitHub PR URL or owner/repo#number.");
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid pull request number.");
  const repository = `${match[1]}/${match[2]}`;
  return { repository, number, url: `https://github.com/${repository}/pull/${number}` };
}

const fields = "state,headRefOid,mergeStateStatus,reviews,statusCheckRollup";

export async function readPullRequest(ref: PullRequestRef): Promise<PullRequestSnapshot> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "gh",
      [
        "pr",
        "view",
        String(ref.number),
        "--repo",
        `github.com/${ref.repository}`,
        "--json",
        fields,
      ],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    ));
  } catch {
    // gh may print credential details in stderr. Surface only a generic operator hint.
    throw new Error(`Could not read ${ref.url}. Check gh authentication and repository access.`);
  }
  const raw = JSON.parse(stdout) as {
    state?: string;
    headRefOid?: string;
    mergeStateStatus?: string;
    reviews?: Array<{
      id?: string;
      state?: string;
      body?: string;
      submittedAt?: string;
      author?: { login?: string };
    }>;
    statusCheckRollup?: Array<{
      name?: string;
      context?: string;
      conclusion?: string | null;
      state?: string | null;
      completedAt?: string | null;
      detailsUrl?: string | null;
      targetUrl?: string | null;
    }>;
  };
  if (!raw.state || !raw.headRefOid)
    throw new Error(`GitHub returned incomplete PR data for ${ref.url}.`);
  return {
    state: raw.state,
    headRefOid: raw.headRefOid,
    mergeStateStatus: raw.mergeStateStatus ?? "UNKNOWN",
    checks: (raw.statusCheckRollup ?? []).map((check) => ({
      name: check.name ?? check.context ?? "Check",
      conclusion: check.conclusion ?? check.state ?? null,
      completedAt: check.completedAt ?? null,
      detailsUrl: check.detailsUrl ?? check.targetUrl ?? null,
    })),
    reviews: (raw.reviews ?? [])
      .filter((review) => Boolean(review.id && review.submittedAt))
      .map((review) => ({
        id: review.id!,
        state: review.state ?? "UNKNOWN",
        author: review.author?.login ?? "unknown",
        body: review.body ?? "",
        submittedAt: review.submittedAt!,
      })),
  };
}
