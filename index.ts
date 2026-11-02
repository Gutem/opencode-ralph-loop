import { Plugin } from "@opencode/plugin"
import { decide, initialState, parseCommand, renderKickoff, type State } from "./state.js"

const PREFIX = "session:"
const CHILD = "child:"
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
    const clearInstruction = (sessionID: string) =>
      ctx.session.instructions.entry.remove({ sessionID, key: "ralph-loop" }).catch(() => {})

    /** Every iteration runs in a new Session, so it starts with a clean context. */
    const startChild = async (parentID: string, state: Stored, text: string) => {
      const child = await ctx.session.create({
        title: `Ralph ${state.iteration + 1}/${state.maxIterations}`,
        metadata: { ralphParent: parentID },
      })
      await ctx.storage.set(CHILD + child.id, parentID)
      await ctx.session.instructions.entry.put({ sessionID: child.id, key: "ralph-loop", value: text })
      await ctx.session.prompt({ sessionID: child.id, text })
      return child.id
    }

    const stopChild = async (state: Stored | undefined) => {
      if (!state?.childID) return
      await ctx.session.interrupt({ sessionID: state.childID }).catch(() => {})
      await ctx.storage.remove(CHILD + state.childID)
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "ralph-loop",
        description: "repeat the same task in fresh sessions until a completion marker or max iterations",
        execute: async (input) => {
          const parsed = parseCommand(input.prompt.text)
          if ("error" in parsed) throw new Error(parsed.error)

          const previous = await read(input.sessionID)
          await stopChild(previous)
          if (previous?.childID) await clearInstruction(previous.childID)

          const state: Stored = { ...initialState(parsed), boot }
          await write(input.sessionID, state)
          await ctx.session.instructions.entry.put({
            sessionID: input.sessionID,
            key: "ralph-loop",
            value: renderKickoff(parsed.prompt, parsed.completion),
          })

          const childID = await startChild(input.sessionID, state, renderKickoff(parsed.prompt, parsed.completion))
          await write(input.sessionID, { ...state, childID })
        },
      })
      editor.add({
        name: "cancel-ralph",
        description: "cancel the active Ralph loop in this session",
        execute: async (input) => {
          const state = await read(input.sessionID)
          await stopChild(state)
          if (state?.childID) await clearInstruction(state.childID)
          await write(input.sessionID, undefined)
          await clearInstruction(input.sessionID)
        },
      })
    })

    await ctx.session.hook("experimental.idle", async (event) => {
      // A child session is one iteration of the loop; the parent keeps the state.
      const parentID = await ctx.storage.get(CHILD + event.sessionID)
      if (typeof parentID === "string") {
        const parent = await read(parentID)
        if (parent?.status !== "active" || parent.childID !== event.sessionID) {
          await ctx.storage.remove(CHILD + event.sessionID)
          return
        }
        if (parent.boot !== boot) {
          await write(parentID, {
            ...parent,
            status: "paused",
            reason: "The server restarted while the loop was active",
          })
          await clearInstruction(parentID)
          await clearInstruction(event.sessionID)
          await ctx.storage.remove(CHILD + event.sessionID)
          return
        }

        const messages = await ctx.session.context({ sessionID: event.sessionID })
        const decision = decide({ state: parent, assistantText: assistantText(messages) })
        await ctx.storage.remove(CHILD + event.sessionID)

        if (decision.kind !== "continue") {
          await write(parentID, { ...decision.state, boot: parent.boot })
          await clearInstruction(parentID)
          await clearInstruction(event.sessionID)
          return
        }

        const next: Stored = { ...decision.state, boot: parent.boot }
        const childID = await startChild(parentID, next, decision.text)
        await write(parentID, { ...next, childID })
        return
      }

      // Parent: a running child is the loop. Without one, the loop cannot continue safely.
      const state = await read(event.sessionID)
      if (state?.status !== "active") return
      if (state.boot !== boot) {
        await write(event.sessionID, {
          ...state,
          status: "paused",
          reason: "The server restarted while the loop was active",
        })
        await clearInstruction(event.sessionID)
        return
      }
      if (state.childID) return
      await write(event.sessionID, { ...state, status: "paused", reason: "No active iteration Session" })
      await clearInstruction(event.sessionID)
    })
  },
})
