#!/usr/bin/env node
/* SANFLIX launcher: one command from a fresh download to a running, opened app.
 *
 *   npm install
 *   npm run dev        # this computer only (http://127.0.0.1:5000), opens your browser
 *   npm start          # same, but other devices on your Wi-Fi can connect (they need the password)
 *
 * What it does, in order (each step is skipped when it is already done):
 *   1. finds Python 3.10+          4. creates sanflix.env with random secrets (never printed)
 *   2. creates .venv               5. scans your media/ folder (skipped with a hint if FFmpeg is missing)
 *   3. installs requirements.txt   6. starts the server and opens the browser when it answers
 *
 * Options:  --lan  --no-open  --no-scan  --setup-only  --port <n>  --hls (also prepare HLS in the background)
 * Environment: PYTHON (path to a specific Python), SANFLIX_PORT, SANFLIX_HOST.
 */
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const WINDOWS = process.platform === "win32";

const say = (text = "") => console.log(text);
const step = (text) => console.log(`\n▶ ${text}`);
const warn = (text) => console.log(`  ! ${text}`);
const fail = (text, code = 1) => { console.error(`\n✖ ${text}\n`); process.exit(code); };

// ---------- 1. Python ----------
function findPython() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push([process.env.PYTHON]);
  candidates.push(["python3"], ["python"]);
  if (WINDOWS) candidates.push(["py", "-3"]);
  for (const [command, ...prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" });
    if (probe.status !== 0) continue;
    const [major, minor] = String(probe.stdout).trim().split(".").map(Number);
    if (major === 3 && minor >= 10) return { command, prefix, version: `${major}.${minor}` };
  }
  return null;
}

function run(python, argv, options = {}) {
  return spawnSync(python.command, [...python.prefix, ...argv], { cwd: ROOT, stdio: "inherit", ...options });
}

// ---------- helpers ----------
function freePort(start, host) {
  return new Promise((resolve) => {
    const attempt = (port, left) => {
      const server = net.createServer();
      server.once("error", () => (left > 0 ? attempt(port + 1, left - 1) : resolve(null)));
      server.once("listening", () => server.close(() => resolve(port)));
      server.listen(port, host);
    };
    attempt(start, 20);
  });
}

function waitForServer(port, ms) {
  const end = Date.now() + ms;
  return new Promise((resolve) => {
    const poll = () => {
      const request = http.get({ host: "127.0.0.1", port, path: "/login", timeout: 1500 }, (response) => { response.resume(); resolve(true); });
      request.on("error", () => (Date.now() < end ? setTimeout(poll, 500) : resolve(false)));
      request.on("timeout", () => request.destroy());
    };
    poll();
  });
}

function openBrowser(url) {
  const [command, argv] = WINDOWS ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(command, argv, { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch (_) { /* The address is printed anyway. */ }
}

(async () => {
  say("SANFLIX — your library, your cinema");

  step("Checking Python");
  const found = findPython();
  if (!found) {
    fail("Python 3.10 or newer was not found.\n  Install it from https://www.python.org/downloads/ (on Windows tick \"Add python.exe to PATH\"),\n  then open a new terminal and run this again. You can also set PYTHON to the full path of python.");
  }
  say(`  Python ${found.version}`);

  // ---------- 2 + 3. virtual environment and requirements ----------
  step("Preparing Python packages");
  const venvDir = path.join(ROOT, ".venv");
  const venvPython = path.join(venvDir, WINDOWS ? "Scripts" : "bin", WINDOWS ? "python.exe" : "python");
  let python = found;
  if (!fs.existsSync(venvPython)) {
    say("  Creating .venv (first run only)...");
    const created = run(found, ["-m", "venv", ".venv"]);
    if (created.status !== 0 || !fs.existsSync(venvPython)) {
      warn("Could not create a virtual environment (on Debian/Ubuntu: sudo apt install python3-venv). Using the system Python instead.");
    }
  }
  if (fs.existsSync(venvPython)) python = { command: venvPython, prefix: [], version: found.version };
  const stampFile = path.join(venvDir, ".requirements-stamp");
  const wanted = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "requirements.txt"))).digest("hex");
  let have = "";
  try { have = fs.readFileSync(stampFile, "utf8").trim(); } catch (_) { /* first run */ }
  if (have !== wanted) {
    say("  Installing requirements.txt (first run, or it changed; this can take a minute)...");
    const installed = run(python, ["-m", "pip", "install", "--disable-pip-version-check", "-r", "requirements.txt"]);
    if (installed.status !== 0) fail("Installing the Python packages failed. Check your internet connection and try again.");
    if (fs.existsSync(venvDir)) fs.writeFileSync(stampFile, wanted);
  } else {
    say("  Already installed.");
  }

  // ---------- 4. secrets ----------
  step("Checking your settings");
  const envFile = path.join(ROOT, "sanflix.env");
  if (!fs.existsSync(envFile)) {
    run(python, ["make_secrets.py"]);
    say("  Created sanflix.env with random passwords. Open it to read them (keep it private).");
  } else {
    say("  sanflix.env found.");
  }
  const check = run(python, ["serve.py", "--check"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (check.status !== 0) fail(`${String(check.stdout || "") + String(check.stderr || "")}`.trim() || "The settings are incomplete.", 2);

  // ---------- 5. media scan ----------
  const toolPath = WINDOWS && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "ffmpegio", "ffmpeg-downloader", "ffmpeg", "bin") : "";
  const childEnv = { ...process.env, PYTHONIOENCODING: "utf-8", PATH: toolPath && fs.existsSync(toolPath) ? toolPath + path.delimiter + process.env.PATH : process.env.PATH };
  for (const folder of ["media/movies", "media/series", "media/music", "database", "thumbnails"]) fs.mkdirSync(path.join(ROOT, folder), { recursive: true });
  const hasFfmpeg = ["ffmpeg", "ffprobe"].every((tool) => spawnSync(tool, ["-version"], { stdio: "ignore", env: childEnv }).status === 0);
  if (!hasFfmpeg) {
    step("FFmpeg not found");
    warn("SANFLIX needs FFmpeg and FFprobe to read your videos. Install them, then run this again:");
    warn(WINDOWS ? "  winget install Gyan.FFmpeg      (or https://ffmpeg.org/download.html)" : process.platform === "darwin" ? "  brew install ffmpeg" : "  sudo apt install ffmpeg");
    warn("The app will still start so you can look around; your library stays empty until FFmpeg is installed.");
  } else if (!flag("--no-scan")) {
    step("Scanning your media folder (put files in media/movies, media/series, media/music)");
    const scan = run(python, ["scan_media.py"], { env: childEnv });
    if (scan.status !== 0) warn("The scan reported a problem. The app will still start; your previous catalogue (if any) was kept.");
  }
  if (flag("--setup-only")) { say("\nSetup finished. Start the app with: npm run dev"); return; }

  // ---------- 6. server ----------
  const lan = flag("--lan") || process.env.npm_lifecycle_event === "start";
  const host = process.env.SANFLIX_HOST || (lan ? "0.0.0.0" : "127.0.0.1");
  const wantedPort = Number(option("--port") || process.env.SANFLIX_PORT || 5000);
  const port = await freePort(wantedPort, host);
  if (!port) fail(`No free port found from ${wantedPort} upward.`);
  if (port !== wantedPort) warn(`Port ${wantedPort} is busy (is SANFLIX already running?), using ${port} instead.`);
  const url = `http://localhost:${port}`;

  if (flag("--hls") && hasFfmpeg) {
    fs.mkdirSync(path.join(ROOT, "database"), { recursive: true });
    const log = fs.openSync(path.join(ROOT, "database", "hls-conversion.log"), "w");
    spawn(python.command, [...python.prefix, "convert_hls.py"], { cwd: ROOT, env: childEnv, stdio: ["ignore", log, log], detached: true }).unref();
    say("  Preparing HLS in the background. Progress: database/hls-conversion.log");
  }

  step(lan ? "Starting SANFLIX (other devices on your network can connect)" : "Starting SANFLIX (this computer only)");
  const server = spawn(python.command, [...python.prefix, "serve.py"], { cwd: ROOT, stdio: "inherit", env: { ...childEnv, SANFLIX_HOST: host, SANFLIX_PORT: String(port) } });
  const stop = () => { try { server.kill(); } catch (_) { /* already gone */ } };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  server.on("exit", (code) => { say("\nSANFLIX stopped."); process.exit(code || 0); });

  if (await waitForServer(port, 60000)) {
    say(`\n  SANFLIX is running at ${url}`);
    say("  Press Ctrl+C to stop.");
    if (!flag("--no-open")) openBrowser(url);
  } else {
    warn("The server did not answer within a minute. Check the messages above.");
  }
})().catch((error) => fail(error && error.stack ? error.stack : String(error)));
