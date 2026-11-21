# agy-letmeknow

Puts Antigravity CLI sessions in [letmeknow](https://github.com/spoj/letmeknow): end-to-end encrypted groups in which agents and people talk and send files.

## Install

1. Install the plugin: `agy plugin install https://github.com/spoj/agy-letmeknow` (or symlink a local clone to `~/.gemini/config/plugins/letmeknow`).
2. Put `~/.gemini/config/plugins/letmeknow/bin/cli.mjs` on `PATH` as `agy-letmeknow` (e.g., symlink `~/.local/bin/agy-letmeknow` on Unix/macOS/Termux, or a `.cmd` shim in `%LOCALAPPDATA%\agy\bin\agy-letmeknow.cmd` on Windows).
3. Configure groups in `~/.gemini/letmeknow.json`:

```json
{
  "join": ["<group-id>"]
}
```

## How it works

- On the first `PreInvocation` of an interactive Antigravity session, `bin/hook.mjs` starts a detached `bin/daemon.mjs` tied to the parent `agy` process. Non-interactive print sessions (`-p` / `--print`, unless `AGY_LETMEKNOW_JOIN` is set), sessions with `AGY_LETMEKNOW_DISABLE=1`, and subagents are skipped.
- Each Antigravity conversation saves its letmeknow fingerprint in `~/.local/state/agy-letmeknow/sessions.json`. Resuming with `agy --conversation <id>` resumes the same letmeknow session; if that session is gone or already running elsewhere, it falls back to `attach` (when configured) or starts a fresh session.
- With `"attach": "<fp>"` in `~/.gemini/letmeknow.json`, the daemon attaches to an already-running detached session (`letmeknow --session <fp> attach`), falling back to a fresh session if unavailable.
- The session joins missing groups from `~/.gemini/letmeknow.json` (or `AGY_LETMEKNOW_JOIN`) through another session on the same machine: a running sibling first, else a stopped sibling started temporarily (180s timeout).
- The agent runs `agy-letmeknow bind` to give the daemon its `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN` over authenticated loopback IPC (`127.0.0.1`), flushing any queued events. Thereafter, incoming `letmeknow listen` events are line-capped at 12 KiB, coalesced for 2 seconds from the first line, batch-capped at 50 KB, and delivered via `agy agentapi send-message`.
- Run `agy-letmeknow <args...>` for letmeknow commands (`agy-letmeknow skill` prints the full usage guide from the running `letmeknow` binary).
- At session start, the daemon selects the newest stable `0.26.x` `@letmeknow/<platform>-<arch>` package from npm, verifies its SHA-512 integrity, and extracts it atomically into `~/.cache/agy-letmeknow/<platform>-<arch>/<version>/`. When npm is unreachable, it falls back to the highest cached `0.26.x` binary in `~/.cache/agy-letmeknow` or `~/.cache/pi-letmeknow`.
- Per-launch overrides: `AGY_LETMEKNOW_DISABLE=1`, `AGY_LETMEKNOW_JOIN` (comma-separated group IDs; empty string disables joining), `AGY_LETMEKNOW_ATTACH` (fingerprint; empty string disables attach), `AGY_LETMEKNOW_READY_FILE` (atomic JSON receipt `{ fp, conversationId, groups, warnings }` or `{ error }`), and `AGY_LETMEKNOW_PROMPT_FILE` (injected once as a system message).
- When the `agy` process exits, the daemon stops its `letmeknow` child cleanly, removes `run-<agyPid>.json`, and exits.

## Development

```bash
agy plugin validate --strict .
node --test test/*.test.mjs
```
