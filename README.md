# model-router

**The right model and effort for every task, and fewer tokens spent getting there.**

Claude Code runs every prompt on the one model and effort level you picked for the session. If that is Opus or Fable at high effort, a typo fix, a file rename or a quick question costs as much as an architecture change. model-router picks the model and effort for each task before it starts. Simple work goes to Haiku or Sonnet at low effort, and the larger models are saved for work that needs them.

- **Saves tokens.** Larger models no longer take over simple tasks. A one-line answer on Haiku 5.5 costs a small fraction of the same answer on Fable 5.1.
- **Keeps quality where it matters.** Hard, risky or multi-file work still goes to Opus or Fable at the effort it needs. A task that turns out harder than it looked is moved up mid-task.
- **Shows its work.** Every task opens with the model and effort chosen and why. It ends with one line per model listing tokens in, tokens out and the dollar cost.

## Install

In Claude Code:

```
/plugin install model-router --marketplace whtirado/model-router
```

Or from a terminal:

```bash
claude plugin install model-router --marketplace whtirado/model-router
```

## How it works

1. **Before each task**, a short Haiku 5.5 call reads your prompt and the last few messages, then picks Haiku 5.5, Sonnet 5.5, Opus 5.5 or Fable 5.1 at low, medium or high effort. If that call fails or times out, keyword and length rules decide instead.
2. **Approvals follow the conversation.** "Yes", "do it" or "go ahead" after a hard discussion keeps the model and effort of the task being approved, instead of dropping to Haiku.
3. **Every request of the task** runs on the chosen model and effort. A dim line in the transcript says what was chosen, and the status line shows it while the task runs.
4. **Subagents run cheaper.** A subagent the task starts runs on a cheaper model unless Claude named one: Explore on Haiku at low effort, Plan on the task's own model, others on Sonnet at medium effort. A subagent never runs above the task it serves. For large tasks, Claude is told it may hand independent parts to subagents.
5. **When the task ends**, one line per model and effort shows what it used:

```
Opus 5.5 - High [in tokens 39000] [out tokens 1500] $0.096
Haiku 5.5 (router) - Low [in tokens 400] [out tokens 30] $0.0001
```

"In tokens" counts everything the model read: new input, cache reads and cache writes. Subagents and the router's own calls get their own lines.

## Long tasks

Once a task has made 25 model requests or run 5 minutes, a short Haiku 5.5 check looks at the recent conversation, the failed tool calls and the subagents started so far. It runs again after each further 25 requests or 5 minutes, at most three times per task. It decides two things:

- **Whether the task needs more.** It can raise the effort or move to the next model up: Haiku, then Sonnet, Opus and Fable. The rest of the task runs on the new choice. A session pinned with `/route` keeps its model.
- **Whether to use subagents.** If independent parts remain, Claude gets a note with its next tool result.

A dim line says what the check decided. If the check cannot answer, four or more failed tool calls count as stuck, and a task with no subagents yet gets them suggested.

## Commands

- `/route` or `/route status`: what is pinned and what the current task runs on.
- `/route off`: stop routing; tasks run on the session's own model and effort.
- `/route auto` or `/route on`: resume routing.
- `/route opus` or `/route sonnet high`: pin a model, optionally with an effort, for the session.
- `/route stats`: session and all-time cost tables.
- `/route last`: the last task's table again.
- `/route reset`: clear the tallies.

## Costs

Dollar figures are estimates at the first-party API rates dated in the code (`PRICES_DATED`). They price uncached input, cache reads, cache writes and output separately, and charge Haiku 5.5 prompts over 100,000 tokens at the long-prompt rate. On a subscription they are not a charge, only a comparison.

The API does not say whether a cache write used the 5-minute or 1-hour cache. The `cacheTtl` setting picks which rate the estimate uses; the default is 1 hour.

## Data and privacy

The plugin has no servers of its own and sends nothing outside Claude Code. Its only network traffic is the model calls Claude Code already makes for you:

- **Routing call.** Before each task, one short Haiku 5.5 request is made through Claude Code with your prompt (first 6000 characters) and the last six messages of the conversation, each cut to 700 characters, so the choice can follow the context. The same kind of call is made when a long task is checked. If a call fails, built-in rules decide instead.
- **Local storage.** Token counts, dollar estimates and task totals are kept in Claude Code's per-plugin store on your machine. No prompt text is stored.
- **Hidden notes.** For large or long tasks the plugin adds a short note to the model's context suggesting subagents. It never changes tools, permissions or files.
- **Model and effort changes.** It rewrites the model and effort of each request in the session. `/route off` turns that off.

## Setup

The `cacheTtl` option (5m or 1h, default 1h) sets which cache-write price the estimate uses. Nothing else to configure.

## Development

Run the tests with `claude plugin test .` from the plugin folder. They cover every statement, branch and function of the router.
