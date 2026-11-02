import { Plugin } from "@opencode/plugin"
import { decide, initialState, parseCommand, renderContinuation, renderKickoff, type State } from "./state.js"

const PREFIX = "session:"
const boot = crypto.randomUUID()

type Stored = State & { readonly boot: string; readonly childID?: string }

function assistantText(messages: ReadonlyArray<unknown>): string {
  const parts: string[] = []
  for (const message of messages) {
    const item = message as { type?: string; content?: Array<{ type?: string; text?: string }> }
    if (item.type !== "assistant" || !item.content) continue
    for (const part of item.content) if (part.type === "text" && typeof part.text === "string") parts.push(part.text)
  }
  return parts.join("\n")
}

export default Plugin.define({
  id: "opencode.ralph-loop",
  async setup(ctx) {
    const read = async (sessionID: string): Promise<Stored | undefined> => {
      const value = await ctx.storage.get(PREFIX + sessionID)
      return value as Stored | undefined
    }
    const write = async (sessionID: string, state: Stored | undefined) => {
      if (state) await ctx.storage.set(PREFIX + sessionID, state)
      else await ctx.storage.remove(PREFIX + sessionID)
    }

    /** The parent loop runs each iteration in a new Session, then waits for it to go idle. */
    const runLoop = async (parentID: string, start: Stored) => {
      let state = start
      while (state.status === "active") {
        if (state.boot !== boot) {
          await write(parentID, { ...state, status: "paused", reason: "The server restarted while the loop was active" })
          return
        }

        const child = await ctx.session.create({
          title: `Ralph ${state.iteration + 1}/${state.maxIterations}`,
          metadata: { ralphParent: parentID },
        })
        state = { ...state, childID: child.id }
        await write(parentID, state)
        await ctx.session.prompt({
          sessionID: child.id,
          text:
            state.iteration === 0
              ? renderKickoff(state.prompt, state.completion)
              : renderContinuation(state.prompt, state.completion, state.iteration, state.maxIterations),
        })
        await ctx.session.wait({ sessionID: child.id })

        const latest = await read(parentID)
        if (latest?.status !== "active" || latest.childID !== child.id) return

        const messages = await ctx.session.context({ sessionID: child.id })
        const decision = decide({ state: latest, assistantText: assistantText(messages) })
        if (decision.kind !== "continue") {
          await write(parentID, { ...decision.state, boot: latest.boot })
          return
        }
        state = { ...decision.state, boot: latest.boot }
        await write(parentID, state)
      }
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "ralph-loop",
        description: "repeat the same task in fresh sessions until a completion marker or max iterations",
        execute: async (input) => {
          const parsed = parseCommand(input.prompt.text)
          if ("error" in parsed) throw new Error(parsed.error)

          const previous = await read(input.sessionID)
          if (previous?.childID) await ctx.session.interrupt({ sessionID: previous.childID }).catch(() => {})

          const state: Stored = { ...initialState(parsed), boot }
          await write(input.sessionID, state)
          void runLoop(input.sessionID, state).catch(async (error) => {
            await write(input.sessionID, {
              ...state,
              status: "paused",
              reason: error instanceof Error ? error.message : String(error),
            })
          })
        },
      })
      editor.add({
        name: "cancel-ralph",
        description: "cancel the active Ralph loop in this session",
        execute: async (input) => {
          const state = await read(input.sessionID)
          if (state?.childID) await ctx.session.interrupt({ sessionID: state.childID }).catch(() => {})
          await write(input.sessionID, undefined)
        },
      })
    })

  },
})
