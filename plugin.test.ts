import { describe, expect, test } from "bun:test"
import plugin from "./index.js"

type SetupContext = Parameters<typeof plugin.setup>[0]

function harness() {
  const store = new Map<string, unknown>()
  const commands = new Map<string, { execute: (input: unknown) => Promise<void> }>()
  const children: Array<{ id: string; title?: string }> = []
  const prompts: Array<{ sessionID: string; text: string }> = []
  const interrupted: string[] = []
  const messages = new Map<string, unknown[]>()
  let idle: ((event: { sessionID: string; background: unknown[] }) => Promise<void>) | undefined
  let next = 0

  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
    },
    command: {
      transform: async (cb: (editor: { add: (d: unknown) => void }) => void) => {
        cb({ add: (d: unknown) => commands.set((d as { name: string }).name, d as never) })
      },
    },
    session: {
      instructions: { entry: { put: async () => {}, remove: async () => {} } },
      create: async (input?: { title?: string }) => {
        const id = `child_${++next}`
        children.push({ id, title: input?.title })
        return { id, title: input?.title }
      },
      prompt: async (input: { sessionID: string; text: string }) => {
        prompts.push(input)
      },
      interrupt: async (input: { sessionID: string }) => {
        interrupted.push(input.sessionID)
      },
      context: async (input: { sessionID: string }) => messages.get(input.sessionID) ?? [],
      hook: async (name: string, cb: never) => {
        if (name === "experimental.idle") idle = cb
      },
    },
  } as unknown as SetupContext

  return {
    ctx,
    store,
    commands,
    children,
    prompts,
    interrupted,
    setMessages: (sessionID: string, value: unknown[]) => messages.set(sessionID, value),
    idle: (event: { sessionID: string; background: unknown[] }) => {
      if (!idle) throw new Error("idle hook not registered")
      return idle(event)
    },
  }
}

describe("ralph-loop plugin", () => {
  test("registra os comandos e o hook idle", async () => {
    const h = harness()
    await plugin.setup(h.ctx)
    expect([...h.commands.keys()].sort()).toEqual(["cancel-ralph", "ralph-loop"])
  })

  test("cada iteração roda em uma sessão nova até o marker", async () => {
    const h = harness()
    await plugin.setup(h.ctx)
    await h.commands.get("ralph-loop")!.execute({
      sessionID: "ses_parent",
      prompt: { text: "fix tests --completion-promise DONE --max-iterations 3" },
      delivery: "steer",
    })

    expect(h.children).toEqual([{ id: "child_1", title: "Ralph 1/3" }])
    expect(h.prompts[0]?.sessionID).toBe("child_1")
    expect(h.prompts[0]?.text).toContain("fix tests")
    expect(h.store.get("session:ses_parent")).toMatchObject({ iteration: 0, status: "active", childID: "child_1" })

    h.setMessages("child_1", [{ type: "assistant", content: [{ type: "text", text: "still working" }] }])
    await h.idle({ sessionID: "child_1", background: [] })

    expect(h.children.map((c) => c.id)).toEqual(["child_1", "child_2"])
    expect(h.prompts[1]?.text).toContain("iteration 1/3")
    expect(h.store.get("session:ses_parent")).toMatchObject({ iteration: 1, childID: "child_2" })

    h.setMessages("child_2", [{ type: "assistant", content: [{ type: "text", text: "done DONE" }] }])
    await h.idle({ sessionID: "child_2", background: [] })

    expect(h.children).toHaveLength(2)
    expect(h.store.get("session:ses_parent")).toMatchObject({ status: "done" })
  })

  test("max-iterations 1 para depois da primeira sessão", async () => {
    const h = harness()
    await plugin.setup(h.ctx)
    await h.commands.get("ralph-loop")!.execute({
      sessionID: "ses_one",
      prompt: { text: "task --max-iterations 1" },
      delivery: "steer",
    })
    h.setMessages("child_1", [{ type: "assistant", content: [{ type: "text", text: "working" }] }])
    await h.idle({ sessionID: "child_1", background: [] })

    expect(h.children).toHaveLength(1)
    expect(h.store.get("session:ses_one")).toMatchObject({ status: "paused" })
  })

  test("cancelar interrompe a sessão filha e remove o estado", async () => {
    const h = harness()
    await plugin.setup(h.ctx)
    await h.commands.get("ralph-loop")!.execute({
      sessionID: "ses_cancel",
      prompt: { text: "task" },
      delivery: "steer",
    })
    await h.commands.get("cancel-ralph")!.execute({
      sessionID: "ses_cancel",
      prompt: { text: "" },
      delivery: "steer",
    })

    expect(h.interrupted).toEqual(["child_1"])
    expect(h.store.has("session:ses_cancel")).toBe(false)
  })
})
