// What Tailscale says about this PC, for the Phone tab in Settings.
//
// Read-only: it asks the tailscale command two questions and changes nothing.
// Setting up `tailscale serve` changes what this machine offers on the user's
// network, so it is left to them — the tab shows the one command to run.
//
// The parsing is pure and tested; running the command is the thin part.

import { execFile } from "node:child_process";
import fs from "node:fs";

const WINDOWS_PATH = "C:\\Program Files\\Tailscale\\tailscale.exe";

/** The tailscale command: the standard Windows install, else whatever PATH finds. */
export function tailscaleCommand({ platform = process.platform, exists = fs.existsSync } = {}) {
  if (platform === "win32" && exists(WINDOWS_PATH)) return WINDOWS_PATH;
  return "tailscale";
}

/** From `tailscale status --json`: this machine's name on the tailnet, and whether it is up. */
export function parseStatus(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  const dnsName = String(data?.Self?.DNSName ?? "").replace(/\.$/, "");
  return { running: data?.BackendState === "Running", dnsName };
}

/**
 * From `tailscale serve status --json`: is anything forwarding to this port on
 * this machine? Only a forward to the loopback address counts — that is what
 * the phone server listens on.
 */
export function servesPort(json, port) {
  const data = typeof json === "string" ? (json.trim() ? JSON.parse(json) : {}) : json;
  const targets = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  for (const site of Object.values(data?.Web ?? {})) {
    for (const handler of Object.values(site?.Handlers ?? {})) {
      if (targets.has(String(handler?.Proxy ?? "").replace(/\/$/, ""))) return true;
    }
  }
  return false;
}

function run(command, args, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * Everything the Phone tab says about Tailscale.
 * @returns {{ installed: boolean, running?: boolean, dnsName?: string, serving?: boolean, address?: string, serveCommand: string }}
 */
export async function tailscaleState(port, { runner = run, command = tailscaleCommand() } = {}) {
  const serveCommand = `tailscale serve --bg ${port}`;
  let status;
  try {
    status = parseStatus(await runner(command, ["status", "--json"]));
  } catch (err) {
    // ENOENT: not installed. Anything else — logged out, stopped — it IS
    // installed, and saying otherwise would send somebody to install it again.
    if (err.code === "ENOENT") return { installed: false, serveCommand };
    return { installed: true, running: false, serveCommand };
  }
  let serving = false;
  try {
    serving = servesPort(await runner(command, ["serve", "status", "--json"]), port);
  } catch {
    serving = false;
  }
  return {
    installed: true,
    running: status.running,
    dnsName: status.dnsName,
    serving,
    address: status.dnsName ? `https://${status.dnsName}/phone/` : "",
    serveCommand,
  };
}
