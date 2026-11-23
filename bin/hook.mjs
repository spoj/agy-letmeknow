import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isAlive, stateDir, writeJsonAtomic } from "./daemon.mjs";

const START_TIMEOUT_MS = 30_000;

export function isSystemTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;
  let fd;
  try {
    fd = openSync(transcriptPath, "r");
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const firstLine = buf.toString("utf8", 0, n).split("\n", 1)[0];
    return /"source"\s*:\s*"SYSTEM"/.test(firstLine);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function tokenizeCmdLine(line) {
  return line ? (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []) : [];
}

export function isPrintArgs(argv) {
  return argv.some(a =>
    a === "-p" || a === "--print" || a === "--prompt" ||
    a.startsWith("-p=") || a.startsWith("--print=") || a.startsWith("--prompt=")
  );
}

function isPrintMode(pid, knownCmdLine) {
  if (knownCmdLine !== undefined) return isPrintArgs(tokenizeCmdLine(knownCmdLine));
  if (process.platform === "linux" || process.platform === "android") {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      return isPrintArgs(argv);
    } catch {
      return false;
    }
  }
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).trim();
      return isPrintArgs(tokenizeCmdLine(out));
    } catch {
      return false;
    }
  }
  return false;
}

function resolveAgyProcess(dir, conversationId) {
  const ppid = process.ppid;
  if (process.platform === "linux" || process.platform === "android") {
    try {
      const argv = readFileSync(`/proc/${ppid}/cmdline`, "utf8").split("\0").filter(Boolean);
      const cmd = basename(argv[0] || "");
      if ((cmd === "sh" || cmd === "dash" || cmd === "bash" || cmd === "zsh") && argv[1] === "-c") {
        const stat = readFileSync(`/proc/${ppid}/stat`, "utf8");
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const gp = Number(rest[1]);
        if (Number.isInteger(gp) && gp > 1) return { pid: gp };
      }
    } catch {}
    return { pid: ppid };
  }
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("ps", ["-o", "ppid=,args=", "-p", String(ppid)], { encoding: "utf8" }).trim();
      const m = out.match(/^(\d+)\s+(.*)$/);
      if (m) {
        if (/^(?:\S*\/)?(?:sh|dash|bash|zsh)\s+-c\b/.test(m[2])) {
          const gp = Number(m[1]);
          if (Number.isInteger(gp) && gp > 1) return { pid: gp };
        }
        return { pid: ppid, cmdLine: m[2] };
      }
    } catch {}
    return { pid: ppid };
  }
  if (process.platform === "win32") {
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.startsWith("run-") || !name.endsWith(".json")) continue;
        try {
          const st = JSON.parse(readFileSync(join(dir, name), "utf8"));
          if (st.conversationId === conversationId && isAlive(st.daemonPid) && isAlive(st.agyPid)) {
            return { pid: st.agyPid };
          }
        } catch {}
      }
    }
    try {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${ppid}'; if ($p -and $p.Name -match '^(cmd|powershell|pwsh)(\\.exe)?$') { $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" }; if ($p) { "$($p.ProcessId)\`t$($p.CommandLine)" }`,
        ],
        { encoding: "utf8", timeout: 5000, windowsHide: true }
      ).trim();
      const tab = out.indexOf("\t");
      const gp = Number(tab === -1 ? out : out.slice(0, tab));
      if (Number.isInteger(gp) && gp > 0) {
        return { pid: gp, cmdLine: tab === -1 ? undefined : out.slice(tab + 1) };
      }
    } catch {}
  }
  return { pid: ppid };
}

async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw.trim();
}

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

export async function runHook(input) {
  if (!input?.conversationId) return {};
  if (process.env.AGY_LETMEKNOW_DISABLE === "1") return {};
  if (!input.lastUserInput && isSystemTranscript(input.transcriptPath)) return {};

  const dir = stateDir();
  const { pid: agyPid, cmdLine } = resolveAgyProcess(dir, input.conversationId);

  const runPath = join(dir, `run-${agyPid}.json`);
  const errPath = join(dir, `err-${agyPid}.txt`);
  let state = readJsonSafe(runPath);

  if (state && isAlive(state.daemonPid)) {
    if (state.conversationId !== input.conversationId) return {};
  } else {
    if (!process.env.AGY_LETMEKNOW_JOIN && isPrintMode(agyPid, cmdLine)) return {};
    rmSync(runPath, { force: true });
    rmSync(errPath, { force: true });
    const daemonPath = join(import.meta.dirname, "daemon.mjs");
    const child = spawn(process.execPath, [daemonPath, String(agyPid), input.conversationId], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    let exited = false;
    let exitCode = null;
    child.on("exit", code => {
      exited = true;
      exitCode = code;
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    state = undefined;
    while (Date.now() < deadline) {
      const candidate = readJsonSafe(runPath);
      if (candidate && candidate.daemonPid === child.pid) {
        state = candidate;
        break;
      }
      if (exited || !isAlive(child.pid)) {
        const errText = existsSync(errPath) ? readFileSync(errPath, "utf8").trim() : `daemon exited (${exitCode})`;
        rmSync(errPath, { force: true });
        return {
          injectSteps: [{ systemMessage: { systemMessage: `letmeknow failed to start: ${errText}` } }],
        };
      }
      await new Promise(r => setTimeout(r, 50));
    }
    child.unref();
    if (!state) {
      return {
        injectSteps: [{ systemMessage: { systemMessage: "letmeknow failed to start: timed out waiting for session daemon." } }],
      };
    }
  }

  const injectSteps = [];
  let dirty = false;

  const promptFile = process.env.AGY_LETMEKNOW_PROMPT_FILE;
  if (promptFile && existsSync(promptFile) && !state.promptInjected) {
    const text = readFileSync(promptFile, "utf8").trim();
    if (text) injectSteps.push({ systemMessage: { systemMessage: text } });
    state.promptInjected = true;
    dirty = true;
  }

  if (!state.introInjected) {
    const groups = state.groups?.length ? state.groups.join(", ") : "none";
    const parts = [
      `You are in letmeknow as session ${state.fp} (groups: ${groups}; log: ${state.log || "none"}).`,
      "Run `agy-letmeknow bind` now so incoming messages wake this session and flush any queued messages.",
      "Use `agy-letmeknow <args...>` for letmeknow commands; run `agy-letmeknow skill` for usage before first use.",
    ];
    if (state.attached) {
      parts.push("Attached to a standalone session; earlier sessions may have spoken as it and its log holds their history.");
    }
    if (state.warnings?.length) {
      parts.push(`Warnings: ${state.warnings.join("; ")}`);
    }
    injectSteps.push({ systemMessage: { systemMessage: parts.join(" ") } });
    state.introInjected = true;
    dirty = true;
  } else if (!state.bound && input.invocationNum === 1) {
    injectSteps.push({
      systemMessage: {
        systemMessage: "Reminder: run `agy-letmeknow bind` so incoming letmeknow messages wake this session.",
      },
    });
  }

  if (dirty) {
    const latest = readJsonSafe(runPath) || state;
    latest.introInjected = state.introInjected;
    latest.promptInjected = state.promptInjected;
    await writeJsonAtomic(runPath, latest);
  }

  return injectSteps.length ? { injectSteps } : {};
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  const raw = await readStdin();
  const input = raw ? JSON.parse(raw) : {};
  const result = await runHook(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
