# Paseo PR watcher

An opt-in [Paseo](https://paseo.sh) plugin that watches a GitHub PR and sends its owning agent a follow-up when checks fail, a review arrives, or the PR develops a merge conflict.

## Setup

1. Run Paseo 0.16.0 beta 1 or newer within the 0.16 series on the daemon and app.
2. Install and authenticate `gh` on the daemon machine. The authenticated account needs read access to the PRs you watch.
3. During review, install with `paseo plugin install git:508-dev/paseo-pr-watcher --ref feat/pr-watcher`. After PR #1 merges, omit `--ref` to use the default branch. The daemon needs Node and npm on its command path; the manifest installs the locked SDK and validation dependencies with lifecycle scripts disabled.
4. In an agent chat, send `/watch-pr https://github.com/owner/repo/pull/123` or `/watch-pr owner/repo#123`.
5. Open **Watched pull requests** in Command Center to view or remove watches.

The plugin does not merge PRs. It sends the agent a request to inspect and address actionable events. It treats the state at enrollment as a baseline, so existing failures do not trigger an immediate follow-up. It polls every two minutes, waits ten minutes between follow-ups, and pauses after five sends per watch. Remove and re-add a watch to begin a new cycle.

## Delivery and storage

The plugin writes an atomic JSON state file at `$PASEO_HOME/plugins/pr-watcher-state.json`, falling back to `~/.paseo/plugins/pr-watcher-state.json` when `PASEO_HOME` is unset. Set `PASEO_PR_WATCHER_STATE_FILE` in the daemon environment to choose an explicit path. The file contains PR references, agent IDs, observed event IDs, and any follow-up awaiting delivery confirmation. It is created with owner-only permissions.

Paseo's `agent.send()` acknowledges daemon acceptance, not completion of the agent turn. The plugin records a pending send before calling it. If the call fails or the plugin restarts mid-send, it marks delivery **uncertain** and does not replay automatically. Check the agent chat, then select **Mark handled** or **Retry (may duplicate)** in the watch list.

The plugin's background poller gets its Paseo SDK session when an app connects or a plugin action runs. After a daemon restart with no app client connected, polling resumes on the next client connection. A future core SDK change could provide an always-available plugin session and remove this limitation.

## Development

```sh
npm ci --include=dev --legacy-peer-deps --ignore-scripts
npm run typecheck
npm run lint
npm run format:check
npm test
```

The plugin uses the published `@getpaseo/plugin` 0.16 beta contract. Tests use fake GitHub snapshots and a temporary state file; they do not call GitHub or a running Paseo daemon.

Licensed under Apache-2.0.
