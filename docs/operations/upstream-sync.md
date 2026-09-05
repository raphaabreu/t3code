# Keeping the fork current

`origin` is `raphaabreu/t3code`; `upstream` is `pingdotgg/t3code`.
The maintained fork is upstream plus a small series of feature commits. Rebase that
series when updating; published fork history may be rewritten. Keep fixes with the
feature they modify rather than accumulating a long series of corrective commits.

## Update in an isolated worktree

Fetch both remotes, record the exact published head, and create a recovery tag before
rewriting. Include any approved local feature work in the recovery point as well.
Push the recovery tag before changing the published branch. Work in a fresh temporary
worktree created from fetched `origin/main`, following the machine's worktree policy.

On that integration branch, run `git rebase upstream/main`. Resolve conflicts using
upstream's current contracts and architecture, carrying only behavior still missing
upstream. Drop patches that upstream now provides. Keep unrelated feature development
out of the update branch. Review `git diff upstream/main...HEAD` and the rebased commit
series; use `git range-diff` against the previous series when investigating changes.

Run focused tests for Wolf discovery, historical usage and cache reloads; automatic
account selection, interrupted-turn recovery and session persistence; project relocation;
and native executable resolution. Typecheck the affected clients and server. Verify
account switching and the usage page in an isolated browser environment with copied data.
Never start the new server against live userdata during verification.

When publishing the rebuilt main is authorized, use an explicit lease against the
recorded published SHA:

```sh
git push --force-with-lease=refs/heads/main:<recorded-origin-main-sha> origin HEAD:main
```

A rejected lease means someone else updated the fork: fetch and account for their
changes before retrying. Do not replace the expected SHA merely to bypass the rejection.
Do not open a PR unless requested. Normal merge or squash integration of a rebuild PR
would retain the old ancestry; publishing a rewritten main requires the explicit update above.

## Recovery and subsequent work

`backup/pre-upstream-rebuild-2026-09-05` preserves the fork and the latest automatic
switching and Wolf usage fixes before the first rebuild. The separate
`backup/origin-main-pre-rebuild-2026-09-05` tag preserves the previously published main.
Create a fresh recovery tag before each later update and keep the previous working
release available. A source tag does not roll back a database migration: snapshot live
userdata before any production upgrade, and restore a matching data backup if needed.

After a rewrite, existing feature branches should transplant only their own commits
with `git rebase --onto origin/main <their-old-fork-base>`. Start new work from fetched
`origin/main`. Keep custom features in separate commits: Wolf, automatic account switching,
project relocation, Claude executable resolution, and local macOS bundle signing.
Check upstream regularly (weekly is a reasonable default) so changes stay manageable.

## Fork CI

CI uses GitHub-hosted Ubuntu and macOS runners on forks, retaining Blacksmith on upstream.
Upstream production relay/mobile deployments and its Cursor webhook run only in
`pingdotgg/t3code`. Keep these small workflow guards when rebasing so fork updates can
be tested without upstream runner registrations or production credentials.

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
