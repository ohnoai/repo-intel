import { execFile } from "node:child_process"

/**
 * Injects `veans prime` into system context on every model request.
 * Safe no-op when `.veans.yml` is absent (veans prime exits 0 with empty output).
 *
 * One file for both OpenCode generations:
 *   - V2 calls `setup(ctx)`. Its `context` hook rebuilds the system prompt on every
 *     agent-loop request, so the text survives compaction without a separate hook.
 *   - V1 (1.18.29+) calls `server()`, which keeps the original hooks.
 * Remove `server()` once nothing runs OpenCode V1.
 */
function prime(directory: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("veans", ["prime"], { cwd: directory, windowsHide: true, timeout: 15_000 }, (err, stdout) =>
      resolve(err ? "" : String(stdout).trim()),
    )
  })
}

// veans prime output only changes when .veans.yml or veans itself changes, so cache it
// briefly instead of spawning the CLI before every model request.
const TTL_MS = 5 * 60_000
function cached(directory: string) {
  let value = ""
  let at = 0
  return async () => {
    if (Date.now() - at > TTL_MS) {
      value = await prime(directory)
      at = Date.now()
    }
    return value
  }
}

export default {
  id: "veans-prime",
  async setup(ctx: any) {
    const get = cached(ctx.location.directory)
    await ctx.session.hook("context", async (event: any) => {
      const text = await get()
      if (text) event.system.push({ type: "text", text })
    })
  },
  async server({ directory }: { directory: string }) {
    return {
      "experimental.chat.system.transform": async (_input: any, output: any) => {
        const text = await prime(directory)
        if (text) output.system.push(text)
      },
      "experimental.session.compacting": async (_input: any, output: any) => {
        const text = await prime(directory)
        if (text) output.context.push(text)
      },
    }
  },
}
