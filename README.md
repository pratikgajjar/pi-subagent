# Pi Subagent

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation.

Each subagent runs in tmux with a dedicated Pi JSONL session. When the parent runs inside tmux, the child opens as a detached window in the parent's tmux session, named after the child and marked with the window option `@pi-subagent=<handle>`. Outside tmux, each child gets its own `pi-subagent-<handle>` session. The parent can inspect status, wait for durable results, steer active work, queue follow-ups, or attach directly to the child TUI.

## Requirements

- Pi
- Node.js 22.19 or newer
- tmux

## Install

Clone into Pi's global extension directory and expose the CLI on `PATH`:

```sh
git clone git@github.com:earendil-works/pi-subagent.git ~/.pi/agent/extensions/subagent
ln -s ../extensions/subagent/subagent.ts ~/.pi/agent/bin/subagent
```

Run `/reload` in an existing Pi session. The extension contributes its bundled skill automatically.

## Usage

Spawn with a descriptive name using the parent session's provider, model, and thinking level:

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

Names appear in the parent UI. Generated handles remain the stable identifiers used by management commands.

Override the model configuration when needed:

```sh
subagent spawn \
  --provider openai-codex \
  --model gpt-5.4-mini \
  --thinking low \
  --prompt "Find the relevant implementation"
```

Provide multiple prompt fragments and files:

```sh
subagent spawn \
  --file /tmp/spec.md \
  --prompt "Implement this specification" \
  --prompt "Run the targeted tests"
```

Restrict tools for a read-only investigation:

```sh
subagent spawn --tools read,grep,find,ls --prompt "Investigate the failure"
```

Manage a run by its generated handle:

```sh
subagent status a1b2c3
subagent rename a1b2c3 "error handling review"
subagent send a1b2c3 "Focus on error handling"
subagent send a1b2c3 --follow-up "Then summarize"
subagent wait a1b2c3
subagent stop a1b2c3
subagent list
```

Use `/subagent`, or Left on an empty prompt, to select and attach to an active child. The widget below the editor shows a summary line and, while any child works, one row per child: state, time in that state, its last tool call or reply, output tokens and cost.

When a child finishes, fails, or exits, the parent receives a `subagent-result` message with the reply and starts a turn if it is idle, so a parent does not need to block on `wait`. Children that finish together arrive in one message; a result that `wait` already printed is not sent again.

## Isolation

Optional spawn flags:

- `--tools <names>`: comma-separated tool allowlist
- `--no-extensions`: disable extension discovery while retaining the control bridge
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files

Nested subagents are disabled. Child sessions do not receive the subagent skill. Children survive `/reload`. When their spawning Pi session quits or is replaced, running children are suspended: the process stops, but transcript and metadata are kept. Resuming that parent session relaunches them idle with their full history. `subagent stop` removes a run permanently.
