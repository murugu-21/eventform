import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Scale-to-zero activity signal. When ACTIVITY_FILE is set (prod), the API
// stamps it on startup and on every real (non-/health) request. The file's
// mtime is the last-activity time the on-box idle-check reads to decide whether
// to scale the box to 0. Unset in dev → a no-op. Writes are fire-and-forget:
// this must never delay or fail a request.
export const ACTIVITY_FILE = process.env.ACTIVITY_FILE ?? "";

let dirReady = false;

export function stampActivity(now: number = Date.now()): void {
  if (!ACTIVITY_FILE) return;
  if (!dirReady) {
    try {
      mkdirSync(dirname(ACTIVITY_FILE), { recursive: true });
    } catch {
      /* best effort — the dir is normally a mounted volume */
    }
    dirReady = true;
  }
  // Write epoch SECONDS — the on-box idle-check compares this to `date +%s`.
  void writeFile(ACTIVITY_FILE, String(Math.floor(now / 1000))).catch(() => {
    /* never break a request on the activity stamp */
  });
}
