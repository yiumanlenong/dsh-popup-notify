# dsh-popup-notify

English | [中文](README.zh.md)

Modal desktop popups for DeepSeek Harness. Three moments that need you back at the window each raise a **topmost dialog that stays until you dismiss it** — not a toast that fades after a few seconds.

- **Needs permission** — a tool asks for approval.
- **Needs a decision** — the model asks you a question, or submits a plan for review.
- **Run finished** — a root agent goes from `running` to `idle`.

Zero npm dependencies. No bundled binaries, no build step, no post-install script: 340 lines of plain ESM driving PowerShell. Windows only.

Requires DeepSeek Harness `0.2.1-rc.2` or newer.

## Install

```sh
dsh plugin --profile web add dsh-popup-notify
```

Then restart, or let the profile patch layer hot-reload. The bundle inserts one row:

```yaml
- insert:
    - id: popup-notify
      name: 'dsh-popup-notify'
```

Uninstall with `dsh plugin --profile web remove dsh-popup-notify`.

The Plugins page shows this bundle's card from resources the package exports: `./locale/en.json` and `./locale/zh.json` supply `meta.title` and `meta.description`, and `./icon` supplies the artwork. DSH resolves those paths through Node's module resolver without loading the plugin, so a manifest that exports only `.` renders the bare package name with no description and the default icon.

## Why a modal instead of a toast

Windows toasts disappear on their own and stack up in Notification Center, where it is easy to miss them. When a run is blocked waiting for *you*, a dialog that refuses to leave until dismissed is the honest representation of that state.

The dialog runs in its own process, so it never blocks the agent loop. Only one is on screen at a time — further notices queue and appear as you close the current one.

## Configuration

Override any key on the row's `config` in your profile's `cordis.patch.yml`. A patch replaces the whole `config` value, so restate the keys you want.

```yaml
- id: popup-notify
  config:
    notifyOnComplete: false
    sound: false
```

### Behaviour

| Key | Default | Meaning |
|---|---|---|
| `notifyOnApproval` | `true` | Pop when a tool asks for approval. |
| `notifyOnQuestion` | `true` | Pop when `ask_user_question` or `exit_plan_mode` runs. |
| `notifyOnComplete` | `true` | Pop when a root agent finishes a run. |
| `ignoreSubagents` | `true` | Silence subagents, workflow workers, and AgentTeams members. |
| `sound` | `true` | Play the system asterisk sound with the dialog. |
| `completeCooldownMs` | `10000` | Minimum gap between two completion popups for one session. |
| `plainDialog` | `false` | Drop the topmost owner form. Use if a dialog lands somewhere odd; it may then open behind other windows. |
| `testOnStart` | `false` | Pop once on mount to confirm the PowerShell path works. |
| `traceFile` | `''` | Append a diagnostic line per event and per dialog. Empty disables it. |

### Message templates

Every message is a template. `{placeholder}` is filled from the event; unknown placeholders stay verbatim.

| Key | Default |
|---|---|
| `title` | `DeepSeek Harness` |
| `approvalMessage` | `工具 {tool} 需要你的权限确认` |
| `approvalReasonSuffix` | `\n\n理由：{reason}` |
| `questionMessage` | `需要你的回答：{question}` |
| `questionCountSuffix` | `\n\n（共 {count} 个问题，请在对话里逐个回答）` |
| `planReviewMessage` | `有一份计划等你审阅：批准，或继续规划。` |
| `completeMessage` | `Agent 响应已结束，可以查看结果了。` |
| `completeReasonSuffix` | `\n\n（结束原因：{reason}）` |
| `projectSuffix` | `\n\n项目：{project}` |

`{reason}` is the turn's end reason — absent for `completed`, otherwise `aborted`, `error`, `max-tokens`, and so on. `{project}` is the session working directory's basename. Set `projectSuffix: ''` to drop the source line, and `completeReasonSuffix: ''` to stop naming abnormal endings.

## How it hooks in

| Extension point | Mode | Use |
|---|---|---|
| `approval/request` | waterfall | Pops, then `next()` so the configured answerers still decide. |
| `tools/pre-execute` | waterfall | Matches `ask_user_question` and `exit_plan_mode`, pops, then `next()` so the tool runs. |
| `agent/status` | emit | Pops on the `running` → `idle` edge of a root agent. |

DSH exposes no question event: `ctx.userQuestions.ask()` is a service call, and the pending question reaches the browser as a mux frame the host plugin never sees. Matching the two asking tool names at `tools/pre-execute` is the observable point that fires *before* you answer, which is what a reminder needs.

Both waterfalls call `next()`. A listener that returns without it would short-circuit the chain, so approval would resolve `unavailable` and the asking tool would never run.

## Known limitations

- **Windows only.** Other platforms log one warning per notice and skip.
- **Not every approval pops.** With the `never` approval policy the service returns `rejected` before dispatching `approval/request`, so nothing can observe the ask. Session approvals only exist under the `ask` policy.
- **The dialog is not clickable through to the conversation.** It reports state; answering still happens in the DSH window.
- **Only the two asking tools are recognised.** A future interaction tool that also blocks on a human needs its name added to the matcher.
- **One dialog at a time.** A long absence can leave several queued behind the one on screen.
- **`plainDialog: true` loses topmost.** The no-owner MessageBox may open behind other windows.

## Development

```sh
npm test                      # 22 unit tests, no dialogs spawned
node tests/smoke-dialog.mjs   # opens and closes one real dialog
```

The unit suite injects a fake `spawnDialog`, so it never touches the screen. `smoke-dialog.mjs` is the only file that opens a real window.

## License

MIT
