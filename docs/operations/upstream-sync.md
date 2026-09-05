# Keeping the fork current

`origin` is the maintained fork; `upstream` is `https://github.com/pingdotgg/t3code.git`.
Keep fork features as small, independently reviewed commits. Use merge commits for upstream
syncs so Git retains the shared history; do not squash an upstream merge or repeatedly
cherry-pick a long upstream series. Avoid rewriting published fork history.

## Inspect before integrating

Fetch both heads and inspect divergence without changing a checkout:

```sh
git fetch origin main
git fetch upstream main
git rev-list --left-right --count origin/main...upstream/main
git log --oneline --no-merges origin/main..upstream/main
git diff --stat upstream/main...origin/main
git merge-tree --write-tree origin/main upstream/main
```

The count is fork-only commits followed by upstream-only commits. `merge-tree` exits with
status 1 for conflicts and lists the affected files; it does not modify the index or working
tree. A clean textual merge still needs review and verification.

## Integrate in a disposable worktree

Create a fresh branch from fetched `origin/main` under the machine's temporary directory.
Merge `upstream/main` there, preserving upstream changes and reapplying only the fork's
remaining behavior. Keep feature development out of this integration branch. Review the full
result against both parents, run focused tests for conflict areas, and publish only when a PR
has been requested. Follow the machine's normal auto-merge and monitoring policy.

## Fork boundaries to preserve

- Wolf: driver registration, RPC adapter, model discovery, text generation, and disk usage
  parsing. Keep native protocol translation under `provider/wolf` and provider layers.
- Automatic accounts: Claude/Codex profile selection and usage-limit recovery. The policy
  is stored in the thread's model selection for persistence compatibility, but edited through
  a narrow `thread.meta.update.credentialMode` command. The decider applies it to the latest
  selection so a stale client cannot undo a concurrent account switch. Model pickers do not
  own the policy. Both web/desktop and mobile expose a separate session control.
- Project relocation and native executable resolution: recheck whether upstream now provides
  the behavior before preserving a separate implementation.

When transcript parsing changes, advance the usage scan-cache version. Closed session files
retain their size and modification time, so they otherwise keep obsolete parsed records.
For an upstream cache-version change, choose a fresh version beyond both parents.

After integrating changes to Claude usage-limit handling, verify a limit signal followed by
terminal failure triggers exactly one compatible-account continuation, and that ordinary
errors, disabled auto-switch, and signals from an old turn do not trigger recovery. Verify
Wolf model discovery and historical usage independently of Claude/Codex routing.

Wolf history uses `WOLF_CODING_AGENT_SESSION_DIR`, or `sessions` under
`WOLF_CODING_AGENT_DIR` (default `~/.wolf/agent`). These are the Wolf CLI environment names;
`WOLF_AGENT_DIR` is not a supported CLI override. Project-local Wolf `sessionDir` settings and
sessions explicitly saved outside these roots are not discovered by the global usage scan.
