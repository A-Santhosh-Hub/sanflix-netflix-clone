/* Which Python the tests should use: PYTHON, else the project's .venv (created by `npm run dev`), else the system one. */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const venv = path.join(root, ".venv", process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python"));
function pick() {
  if (process.env.PYTHON) return process.env.PYTHON;
  if (fs.existsSync(venv)) return venv;
  for (const name of process.platform === "win32" ? ["python"] : ["python3", "python"]) {
    if (spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0) return name;
  }
  return "python";
}
module.exports = pick();
