# Ralph Loop for OpenCode

A standalone plugin that reproduces the Ralph Wiggum technique in OpenCode: the same
task runs again in a **fresh Session** after each turn until the assistant
emits a completion marker or the iteration budget is exhausted.

It is an independent implementation inspired by the Ralph Wiggum technique,
built on the `experimental.idle` Session hook — the same mechanism used by
OpenCode's built-in `/goal`. The parent Session keeps the loop state; each
iteration is a new child Session with a clean context.

## Install

Install directly from Git:

```sh
opencode plugin add 'git+https://github.com/Gutem/opencode-ralph-loop.git'
```

The plugin is distributed only as a Git repository; it is not published to npm.

For local development, add the directory to `plugins` in the project's
`opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./opencode-ralph-loop"],
}
```

## Usage

```text
/ralph-loop "Implement the todo API. Tests must pass." --completion-promise "COMPLETE" --max-iterations 20
```

Options:

| Option                        | Default | Meaning                                           |
| :---------------------------- | ------: | :------------------------------------------------ |
| `--completion-promise <text>` |   empty | exact string the assistant must include to finish |
| `--max-iterations <n>`        |      50 | hard stop; the loop pauses at this count          |

Cancel with:

```text
/cancel-ralph
```

## Behavior

- The parent Session stores the loop state; each iteration creates a new child
  Session and prompts it with the task and the iteration number.
- The task is also a session instruction entry on the parent and on each child,
  so compaction does not lose it.
- Before each continuation the plugin reads the child's assistant messages and
  checks the completion marker.
- Child Sessions are kept after the loop for audit; they are normal Sessions and
  can be inspected or removed by the user.
- A server restart pauses an active loop instead of resuming silently.
- The loop never runs commands by itself: it only prompts child Sessions.

## Safety

- Always set `--max-iterations`.
- Use it for tasks with automatic verification (tests, lint, coverage), not for
  design decisions or actions against external systems.
- The plugin does not bypass permissions or approval; normal tool permissions
  still apply.

## Development

```bash
bun install
bun test
bun typecheck
```
