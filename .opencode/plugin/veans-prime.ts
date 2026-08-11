import type { Plugin } from "@opencode-ai/plugin"

/**
 * Injects `veans prime` into system context on chat + re-injects on compaction.
 * Safe no-op when `.veans.yml` is absent (veans prime exits 0 with empty output).
 */
const VeansPrime: Plugin = async ({ $, directory }) => {
  async function prime(): Promise<string> {
    try {
      const out = await $`veans prime`.cwd(directory).quiet().nothrow()
      return out.text().trim()
    } catch {
      return ""
    }
  }

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      const text = await prime()
      if (text) output.system.push(text)
    },
    "experimental.session.compacting": async (_input, output) => {
      const text = await prime()
      if (text) output.context.push(text)
    },
  }
}

export default VeansPrime
export { VeansPrime }
