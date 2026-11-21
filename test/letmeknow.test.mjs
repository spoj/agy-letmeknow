import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import { promisify } from "node:util";
import { capBatch, capLine, installBinary, isAlive, joinListed } from "../bin/daemon.mjs";
import { isPrintArgs, isSystemTranscript } from "../bin/hook.mjs";

const run = promisify(execFile);
const target = `${process.platform}-${process.arch}`;
const executable = process.platform === "win32" ? "letmeknow.exe" : "letmeknow";
const binDir = join(import.meta.dirname, "..", "bin");
const hookPath = join(binDir, "hook.mjs");
const daemonPath = join(binDir, "daemon.mjs");
const cliPath = join(binDir, "cli.mjs");

const tmpRoot = await mkdtemp(join(tmpdir(), "agy-letmeknow-test-"));
after(async () => {
  mock.restoreAll();
  await rm(tmpRoot, { recursive: true, force: true });
});

async function makeTarball(dir, version, content = `bin-${version}`) {
  const src = await mkdtemp(join(dir, "pkg-"));
  await mkdir(join(src, "package", "bin"), { recursive: true });
  await writeFile(join(src, "package", "bin", executable), content, { mode: 0o755 });
  await run("tar", ["-czf", "package.tgz", "package"], { cwd: src });
  const bytes = await readFile(join(src, "package.tgz"));
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  return { bytes, integrity };
}

async function runNode(script, args, { env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", c => (stdout += c));
    child.stderr.on("data", c => (stderr += c));
    child.on("error", reject);
    child.on("exit", code => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function waitFor(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for condition");
}

test("capLine truncates lines over 12 KiB and leaves shorter lines untouched", () => {
  const short = "x".repeat(12 * 1024);
  assert.equal(capLine(short), short);
  const long = "a".repeat(12 * 1024 + 50);
  const capped = capLine(long);
  assert.ok(capped.startsWith("a".repeat(12 * 1024)));
  assert.match(capped, /line truncated/);
});

test("capBatch enforces 50 KB limit on whole lines", () => {
  const line = "z".repeat(4000);
  const lines = Array.from({ length: 20 }, (_, i) => `${i}:${line}`);
  const batch = capBatch(lines);
  assert.ok(Buffer.byteLength(batch, "utf8") < 52 * 1024);
  assert.match(batch, /output truncated/);
  assert.ok(batch.includes("0:"));
  assert.ok(!batch.includes("19:"));
});

test("isPrintArgs detects -p/--print/--prompt without matching -i", () => {
  assert.equal(isPrintArgs(["agy", "-p", "hi"]), true);
  assert.equal(isPrintArgs(["agy", "--print", "hi"]), true);
  assert.equal(isPrintArgs(["agy", "--print=hi"]), true);
  assert.equal(isPrintArgs(["agy", "--prompt", "hi"]), true);
  assert.equal(isPrintArgs(["agy", "-i", "hi"]), false);
  assert.equal(isPrintArgs(["agy", "--conversation", "abc"]), false);
});

test("isSystemTranscript distinguishes subagent SYSTEM transcripts from user transcripts", async () => {
  const sysFile = join(tmpRoot, "sys.jsonl");
  const userFile = join(tmpRoot, "user.jsonl");
  await writeFile(sysFile, '{"step_index":0,"source":"SYSTEM","type":"SYSTEM_MESSAGE"}\n');
  await writeFile(userFile, '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT"}\n');
  assert.equal(isSystemTranscript(sysFile), true);
  assert.equal(isSystemTranscript(userFile), false);
  assert.equal(isSystemTranscript(join(tmpRoot, "missing.jsonl")), false);
});

test("installBinary downloads verified 0.26.x, rejects bad integrity, and falls back offline to agy/pi cache", async () => {
  const home = await mkdtemp(join(tmpRoot, "home-install-"));
  const origHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const pkg4 = await makeTarball(tmpRoot, "0.26.4", "bin-0.26.4");
    const pkg5 = await makeTarball(tmpRoot, "0.26.5", "bin-0.26.5");
    const tarballUrl4 = "https://fixtures.invalid/0.26.4.tgz";
    const tarballUrl5 = "https://fixtures.invalid/0.26.5.tgz";

    let mode = "online";
    mock.method(globalThis, "fetch", async url => {
      if (mode === "offline") throw new Error("network down");
      if (url === `https://registry.npmjs.org/@letmeknow/${target}`) {
        if (mode === "bad-integrity") {
          return Response.json({
            versions: { "0.26.5": { dist: { tarball: tarballUrl5, integrity: "sha512-WRONG" } } },
          });
        }
        return Response.json({
          versions: {
            "0.25.9": { dist: { tarball: tarballUrl4, integrity: pkg4.integrity } },
            "0.26.4": { dist: { tarball: tarballUrl4, integrity: pkg4.integrity } },
            "0.27.0": { dist: { tarball: tarballUrl5, integrity: pkg5.integrity } },
          },
        });
      }
      if (url === tarballUrl4) return new Response(pkg4.bytes);
      if (url === tarballUrl5) return new Response(pkg5.bytes);
      throw new Error(`unexpected url ${url}`);
    });

    // Online verified download installs 0.26.4 into ~/.cache/agy-letmeknow.
    const bin4 = await installBinary();
    assert.equal(bin4, join(home, ".cache", "agy-letmeknow", target, "0.26.4", "bin", executable));
    assert.equal(await readFile(bin4, "utf8"), "bin-0.26.4");

    // Integrity mismatch rejects without falling back.
    mode = "bad-integrity";
    await assert.rejects(() => installBinary(), /does not match its integrity/);

    // Offline prefers higher cached version even if in pi-letmeknow fallback cache.
    const piDir = join(home, ".cache", "pi-letmeknow", target, "0.26.6", "bin");
    await mkdir(piDir, { recursive: true });
    const piBin = join(piDir, executable);
    await writeFile(piBin, "bin-0.26.6", { mode: 0o755 });
    mode = "offline";
    const warnings = [];
    const offlineBin = await installBinary(w => warnings.push(w));
    assert.equal(offlineBin, piBin);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /running cached 0\.26\.6/);
  } finally {
    mock.restoreAll();
    process.env.HOME = origHome;
  }
});

test("full hook -> daemon -> bind -> wake -> resume -> cleanup lifecycle with fake binaries", async () => {
  const home = await mkdtemp(join(tmpRoot, "home-e2e-"));
  const work = await mkdtemp(join(tmpRoot, "work-e2e-"));
  const fakeBinDir = join(home, ".cache", "agy-letmeknow", target, "0.26.9", "bin");
  await mkdir(fakeBinDir, { recursive: true });
  await mkdir(join(home, ".gemini"), { recursive: true });

  const eventsFile = join(work, "lmk-events.fifo.txt");
  const cmdLogFile = join(work, "cmd-log.jsonl");
  const agySendLog = join(work, "agy-send.jsonl");
  const readyFile = join(work, "ready.json");
  const promptFile = join(work, "prompt.md");
  await writeFile(promptFile, "Custom launch instruction from prompt file.");

  // Create fake letmeknow executable (Node script).
  const fakeLmkPath = join(fakeBinDir, executable);
  const fakeLmk = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(join(work, "lmk-state.json"))};
const cmdLog = ${JSON.stringify(cmdLogFile)};
const eventsFile = ${JSON.stringify(eventsFile)};
appendFileSync(cmdLog, JSON.stringify({ args, hadLmkSession: "LETMEKNOW_SESSION" in process.env }) + "\\n");
const load = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { seq: 0, sessions: {} };
const save = s => writeFileSync(statePath, JSON.stringify(s));

let sessionArg = "";
let rest = [...args];
if (rest[0] === "--session") {
  sessionArg = rest[1];
  rest = rest.slice(2);
}
const cmd = rest[0];
if (cmd === "sessions") {
  const st = load();
  const list = [
    { fp: "sib0000000000001", running: true, groups: ["grp_test_1"] },
    ...Object.entries(st.sessions).map(([fp, v]) => ({ fp, running: v.running, groups: v.groups })),
  ];
  process.stdout.write(JSON.stringify({ sessions: list }) + "\\n");
  process.exit(0);
}
if (cmd === "invite") {
  process.stdout.write(JSON.stringify({ link: "https://letmeknow.dev/i/fake-invite-token" }) + "\\n");
  process.exit(0);
}
if (cmd === "join") {
  const st = load();
  if (st.sessions[sessionArg] && !st.sessions[sessionArg].groups.includes("grp_test_1")) {
    st.sessions[sessionArg].groups.push("grp_test_1");
    save(st);
  }
  process.stdout.write(JSON.stringify({ joined: "grp_test_1" }) + "\\n");
  process.exit(0);
}
if (cmd === "attach") {
  process.stderr.write("cannot attach to missing session\\n");
  process.exit(1);
}
if (cmd === "echo") {
  let stdin = "";
  for await (const chunk of process.stdin) stdin += chunk;
  process.stdout.write(JSON.stringify({ session: sessionArg, rest, stdin }) + "\\n");
  process.exit(0);
}
if (cmd === "listen") {
  const st = load();
  let fp = sessionArg;
  if (!fp) {
    st.seq += 1;
    fp = String(st.seq).padStart(16, "a");
    st.sessions[fp] = { running: true, groups: [] };
    save(st);
  } else if (!st.sessions[fp]) {
    process.stderr.write("unknown session\\n");
    process.exit(1);
  } else {
    st.sessions[fp].running = true;
    save(st);
  }
  process.stdout.write(JSON.stringify({ type: "ready", fp, bin: ${JSON.stringify(fakeLmkPath)}, log: "/tmp/fake.log" }) + "\\n");
  let offset = 0;
  const iv = setInterval(() => {
    if (!existsSync(eventsFile)) return;
    const content = readFileSync(eventsFile, "utf8");
    if (content.length <= offset) return;
    const chunk = content.slice(offset);
    offset = content.length;
    for (const line of chunk.split("\\n").filter(Boolean)) {
      process.stdout.write(line + "\\n");
    }
  }, 50);
  const stop = () => {
    clearInterval(iv);
    const cur = load();
    if (cur.sessions[fp]) cur.sessions[fp].running = false;
    save(cur);
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
`;
  await writeFile(fakeLmkPath, fakeLmk, { mode: 0o755 });
  await chmod(fakeLmkPath, 0o755);

  // Create fake agy executable that records agentapi send-message calls.
  const fakeAgyPath = join(work, "fake-agy");
  await writeFile(
    fakeAgyPath,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(agySendLog)}, JSON.stringify({
  argv: process.argv.slice(2),
  ls: process.env.ANTIGRAVITY_LS_ADDRESS,
  csrf: process.env.ANTIGRAVITY_CSRF_TOKEN,
}) + "\\n");
`,
    { mode: 0o755 }
  );
  await chmod(fakeAgyPath, 0o755);

  // Use a fake parent process so we can kill it to verify daemon cleanup!
  const parent1 = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const convId = "conv-e2e-1";
  const baseEnv = {
    ...process.env,
    HOME: home,
    LETMEKNOW_SESSION: "should-be-stripped",
    AGY_LETMEKNOW_JOIN: "grp_test_1",
    AGY_LETMEKNOW_ATTACH: "dead000000000001", // tests attach fallback to fresh listen
    AGY_LETMEKNOW_READY_FILE: readyFile,
    AGY_LETMEKNOW_PROMPT_FILE: promptFile,
    // Force offline by pointing proxy/nothing? Wait: fake bin is 0.26.9; npm has <= 0.26.x so test with daemon directly
    // OR ensure offline fetch fails? Better: pass NODE_OPTIONS preload? No, let's check:
  };

  // Block external npm fetches in unit tests while preserving loopback IPC fetch.
  const blockNetPath = join(work, "block-net.mjs");
  await writeFile(
    blockNetPath,
    `const orig = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith("http://127.0.0.1:")) return orig(url, opts);
  throw new Error("offline-in-test");
};
`
  );
  const testEnv = {
    ...baseEnv,
    NODE_OPTIONS: `--import=${blockNetPath}`,
  };

  // Guard test 1: AGY_LETMEKNOW_DISABLE=1 skips immediately.
  const disabled = await runNode(hookPath, [], {
    env: { ...testEnv, AGY_LETMEKNOW_DISABLE: "1" },
    input: JSON.stringify({ conversationId: convId, lastUserInput: "hi", invocationNum: 1 }),
  });
  assert.equal(disabled.code, 0);
  assert.deepEqual(JSON.parse(disabled.stdout), {});

  // Guard test 2: subagent SYSTEM transcript with empty lastUserInput skips immediately.
  const sysTranscript = join(work, "subagent.jsonl");
  await writeFile(sysTranscript, '{"step_index":0,"source":"SYSTEM","type":"SYSTEM_MESSAGE"}\n');
  const subSkipped = await runNode(hookPath, [], {
    env: testEnv,
    input: JSON.stringify({ conversationId: "sub-1", lastUserInput: "", transcriptPath: sysTranscript, invocationNum: 1 }),
  });
  assert.equal(subSkipped.code, 0);
  assert.deepEqual(JSON.parse(subSkipped.stdout), {});

  // Start daemon for parent1 (simulating hook spawn for agyPid = parent1.pid).
  const d1 = spawn(process.execPath, [daemonPath, String(parent1.pid), convId], {
    env: testEnv,
    stdio: "ignore",
    detached: true,
  });
  d1.unref();

  const runFile1 = join(home, ".local", "state", "agy-letmeknow", `run-${parent1.pid}.json`);
  const receipt = await waitFor(async () => existsSync(readyFile) && JSON.parse(await readFile(readyFile, "utf8")));
  const state1 = await waitFor(async () => {
    if (!existsSync(runFile1)) return false;
    const s = JSON.parse(await readFile(runFile1, "utf8"));
    return s.groups?.includes("grp_test_1") ? s : false;
  });
  assert.equal(state1.conversationId, convId);
  assert.equal(state1.agyPid, parent1.pid);
  assert.equal(state1.fp, "aaaaaaaaaaaaaaa1");
  assert.deepEqual(state1.groups, ["grp_test_1"]);
  assert.equal(state1.bound, false);

  // Ready file receipt written with fp, conversationId, groups.
  assert.equal(receipt.fp, "aaaaaaaaaaaaaaa1");
  assert.equal(receipt.conversationId, convId);
  assert.deepEqual(receipt.groups, ["grp_test_1"]);

  // Verify LETMEKNOW_SESSION was stripped from letmeknow child processes.
  const cmdLogs = (await readFile(cmdLogFile, "utf8")).trim().split("\n").map(l => JSON.parse(l));
  assert.ok(cmdLogs.length >= 2);
  assert.ok(cmdLogs.every(c => c.hadLmkSession === false));

  // Verify IPC rejects missing/wrong bearer token with 401.
  const unauth = await fetch(`http://127.0.0.1:${state1.ipcPort}/bind`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong" },
    body: JSON.stringify({ lsAddress: "127.0.0.1:9999", csrfToken: "tok" }),
  });
  assert.equal(unauth.status, 401);

  // Emit an incoming event BEFORE bind -> must queue and flush on `agy-letmeknow bind`.
  await writeFile(eventsFile, JSON.stringify({ type: "message", from: "peer1", content: "queued-hello" }) + "\n");
  await new Promise(r => setTimeout(r, 200));

  const bindRes = await runNode(cliPath, ["bind"], {
    env: {
      ...testEnv,
      ANTIGRAVITY_CONVERSATION_ID: convId,
      ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:42424",
      ANTIGRAVITY_CSRF_TOKEN: "secret-csrf",
      ANTIGRAVITY_AGENTAPI_EXE: fakeAgyPath,
    },
  });
  assert.equal(bindRes.code, 0, bindRes.stderr);
  assert.match(bindRes.stdout, /Bound letmeknow session aaaaaaaaaaaaaaa1 \(groups: grp_test_1\)/);
  assert.match(bindRes.stdout, /queued-hello/);

  // run-<pid>.json now shows bound: true.
  const state1Bound = JSON.parse(await readFile(runFile1, "utf8"));
  assert.equal(state1Bound.bound, true);

  // Test cli command passthrough (`agy-letmeknow echo hi` with stdin) + LETMEKNOW_SESSION stripped.
  const echoRes = await runNode(cliPath, ["echo", "hi"], {
    env: {
      ...testEnv,
      ANTIGRAVITY_CONVERSATION_ID: convId,
      ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:42424",
      ANTIGRAVITY_CSRF_TOKEN: "secret-csrf",
      ANTIGRAVITY_AGENTAPI_EXE: fakeAgyPath,
    },
    input: "stdin-payload",
  });
  assert.equal(echoRes.code, 0, echoRes.stderr);
  assert.deepEqual(JSON.parse(echoRes.stdout), {
    session: "aaaaaaaaaaaaaaa1",
    rest: ["echo", "hi"],
    stdin: "stdin-payload",
  });

  // Emit two messages after bind -> coalesced after 2s debounce into ONE `agy agentapi send-message` call.
  await writeFile(
    eventsFile,
    (await readFile(eventsFile, "utf8")) +
      JSON.stringify({ type: "message", from: "peer1", content: "wake-1" }) + "\n" +
      JSON.stringify({ type: "message", from: "peer2", content: "wake-2" }) + "\n"
  );
  const sent = await waitFor(async () => existsSync(agySendLog) && (await readFile(agySendLog, "utf8")).trim(), 5000);
  const sentObj = JSON.parse(sent.split("\n")[0]);
  assert.equal(sentObj.ls, "127.0.0.1:42424");
  assert.equal(sentObj.csrf, "secret-csrf");
  assert.equal(sentObj.argv[0], "agentapi");
  assert.equal(sentObj.argv[1], "send-message");
  assert.equal(sentObj.argv[2], "--title=letmeknow");
  assert.equal(sentObj.argv[3], convId);
  assert.match(sentObj.argv[4], /wake-1/);
  assert.match(sentObj.argv[4], /wake-2/);

  // Kill parent1 -> daemon exits cleanly and removes run-<pid>.json.
  parent1.kill("SIGKILL");
  await waitFor(() => !existsSync(runFile1) && !isAlive(state1.daemonPid), 5000);

  // Resume same conversationId with a new parent2 -> MUST reuse same fp `aaaaaaaaaaaaaaa1`!
  const parent2 = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const d2 = spawn(process.execPath, [daemonPath, String(parent2.pid), convId], {
      env: { ...testEnv, AGY_LETMEKNOW_ATTACH: "" },
      stdio: "ignore",
      detached: true,
    });
    d2.unref();
    const runFile2 = join(home, ".local", "state", "agy-letmeknow", `run-${parent2.pid}.json`);
    const state2 = await waitFor(async () => {
      if (!existsSync(runFile2)) return false;
      const s = JSON.parse(await readFile(runFile2, "utf8"));
      return s.groups?.includes("grp_test_1") ? s : false;
    });
    assert.equal(state2.fp, "aaaaaaaaaaaaaaa1");
    assert.deepEqual(state2.groups, ["grp_test_1"]);
  } finally {
    parent2.kill("SIGKILL");
  }

  // Test hook.mjs live injection (prompt file + intro once + reminder on next invocationNum=1 + subagent guard).
  const hookHome = await mkdtemp(join(tmpRoot, "home-hook-"));
  const hookFakeDir = join(hookHome, ".cache", "agy-letmeknow", target, "0.26.9", "bin");
  await mkdir(hookFakeDir, { recursive: true });
  await writeFile(join(hookFakeDir, executable), fakeLmk, { mode: 0o755 });
  await chmod(join(hookFakeDir, executable), 0o755);
  const hookEnv = {
    ...process.env,
    HOME: hookHome,
    AGY_LETMEKNOW_JOIN: "",
    AGY_LETMEKNOW_ATTACH: "",
    AGY_LETMEKNOW_PROMPT_FILE: promptFile,
    NODE_OPTIONS: `--import=${blockNetPath}`,
  };
  // Use a long-lived wrapper process as parent of hook invocations!
  const driverScript = `
    import { execFileSync } from "node:child_process";
    const run = payload => JSON.parse(execFileSync(process.execPath, [${JSON.stringify(hookPath)}], { input: JSON.stringify(payload), encoding: "utf8" }));
    const r1 = run({ conversationId: "c-hook", lastUserInput: "hello", invocationNum: 1 });
    const r2 = run({ conversationId: "c-hook", lastUserInput: "hello", invocationNum: 2 });
    const r3 = run({ conversationId: "c-hook", lastUserInput: "next turn", invocationNum: 1 });
    const rSub = run({ conversationId: "c-subagent", lastUserInput: "subtask", invocationNum: 1 });
    process.stdout.write(JSON.stringify({ r1, r2, r3, rSub }));
  `;
  const driverFile = join(work, "driver.mjs");
  await writeFile(driverFile, driverScript);
  const drvRes = await runNode(driverFile, [], { env: hookEnv });
  assert.equal(drvRes.code, 0, drvRes.stderr);
  const { r1, r2, r3, rSub } = JSON.parse(drvRes.stdout);
  assert.equal(r1.injectSteps.length, 2);
  assert.match(r1.injectSteps[0].systemMessage.systemMessage, /Custom launch instruction/);
  assert.match(r1.injectSteps[1].systemMessage.systemMessage, /agy-letmeknow bind/);
  assert.match(r1.injectSteps[1].systemMessage.systemMessage, /agy-letmeknow skill/);
  assert.deepEqual(r2, {});
  assert.equal(r3.injectSteps.length, 1);
  assert.match(r3.injectSteps[0].systemMessage.systemMessage, /Reminder: run `agy-letmeknow bind`/);
  assert.deepEqual(rSub, {});
});

test("joinListed starts a stopped sibling temporarily, invites, joins, and stops it", async () => {
  const work = await mkdtemp(join(tmpRoot, "stopped-sib-"));
  const logFile = join(work, "sib.jsonl");
  const fakeBin = join(work, executable);
  await writeFile(
    fakeBin,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
if (args[0] === "sessions") {
  process.stdout.write(JSON.stringify({ sessions: [
    { fp: "stoppedsib000001", running: false, groups: ["grp_stopped"] },
    { fp: "newsession000001", running: true, groups: [] },
  ] }) + "\\n");
  process.exit(0);
}
if (args[0] === "--session" && args[2] === "listen") {
  process.stdout.write(JSON.stringify({ type: "ready", fp: args[1], bin: ${JSON.stringify(fakeBin)} }) + "\\n");
  const iv = setInterval(() => {}, 1000);
  process.on("SIGTERM", () => {
    clearInterval(iv);
    appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(["stopped", args[1]]) + "\\n");
    process.exit(0);
  });
}
if (args[0] === "--session" && args[2] === "invite") {
  process.stdout.write(JSON.stringify({ link: "https://letmeknow.dev/i/from-stopped" }) + "\\n");
  process.exit(0);
}
if (args[0] === "--session" && args[2] === "join") {
  process.stdout.write(JSON.stringify({ joined: "grp_stopped" }) + "\\n");
  process.exit(0);
}
`,
    { mode: 0o755 }
  );
  await chmod(fakeBin, 0o755);

  const ac = new AbortController();
  const res = await joinListed(fakeBin, "newsession000001", ["grp_stopped", "grp_missing"], ac.signal, process.env);
  assert.deepEqual(res.joined, ["grp_stopped"]);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /cannot join grp_missing/);

  const stopped = await waitFor(async () => {
    const lines = (await readFile(logFile, "utf8")).trim().split("\n").map(l => JSON.parse(l));
    return lines.some(l => l[0] === "stopped" && l[1] === "stoppedsib000001");
  });
  assert.equal(stopped, true);
});

