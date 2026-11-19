# model-router

Picks the model and effort level for each prompt before the turn starts, announces the choice in the transcript, and prints a usage and cost table when the task ends.

## What it does

1. On every prompt you submit, a short Haiku 5.5 call classifies the task and picks one of Haiku 5.5, Sonnet 5.5, Opus 5.5 or Fable 5.1, at low, medium or high effort. If that call fails or times out, keyword and length rules decide instead.
2. A dim line in the transcript says what was chosen and why. The status line shows it while the turn runs.
3. Every model request of the turn is sent on that model and effort. Subagent requests are left on their own settings but counted.
4. When the turn ends, a table lists requests, input, output, cached tokens and dollars per model and effort, with the router's own call as its own row, and session and all-time totals.

Dollar figures are API-equivalent estimates from the first-party rates dated in the module (`PRICES_DATED`). On a subscription they are not a charge, only a comparison.

## Long tasks

Once a task has made 25 model requests or run 5 minutes, and again at each further 25 requests or 5 minutes (at most three times), a short Haiku 5.5 check looks at the recent conversation, the failed tool calls and the subagents started so far. It decides two things:

- Whether the task needs more: more effort, or the next model up (Haiku, Sonnet, Opus, Fable). The rest of the task runs on the new choice. A session pinned with `/route` keeps its model.
- Whether independent parts should go to subagents. If so, Claude gets a note with its next tool result.

A dim line says what the check decided. If the check cannot answer, four or more failed tool calls count as stuck, and no subagents so far counts as a reason to suggest them.

## Commands

- `/route` or `/route status`: what is pinned and what the current turn runs on.
- `/route off`: stop routing; turns run on the session's own model and effort.
- `/route auto`: resume classifying.
- `/route opus` or `/route sonnet high`: pin a model, optionally an effort, for the session.
- `/route stats`: session and all-time tables.
- `/route last`: the last task's table again.
- `/route reset`: clear the tallies.

## Data and privacy

The plugin has no servers of its own and sends nothing outside Claude Code. Its only network traffic is the model calls Claude Code already makes for you:

- **Routing call.** Before each task, one short Haiku 5.5 request is made through Claude Code with your prompt (first 6000 characters) and the last six messages of the conversation, each cut to 700 characters, so the choice can follow the context. The same kind of call is made when a long task is checked. If a call fails, built-in rules decide instead.
- **Local storage.** Token counts, dollar estimates and task totals are kept in Claude Code's per-plugin store on your machine. No prompt text is stored.
- **Hidden notes.** For large or long tasks the plugin adds a short note to the model's context suggesting subagents. It never changes tools, permissions or files.
- **Model and effort changes.** It rewrites the model and effort of each request in the session. `/route off` turns that off.

## Setup

The `cacheTtl` option (5m or 1h, default 1h) sets which cache-write price the estimate uses. Nothing else to configure.
