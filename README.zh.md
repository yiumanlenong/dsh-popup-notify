# dsh-popup-notify

[English](README.md) | 中文

DeepSeek Harness 的桌面弹窗提醒。三种需要你回到窗口的时刻，各弹一个**置顶对话框，不点掉就不会消失**——不是几秒后自动淡出的 toast。

- **需要权限** —— 工具请求审批。
- **需要选择** —— 模型向你提问，或提交计划等你审阅。
- **任务完成** —— 根 agent 从 `running` 落到 `idle`。

零 npm 依赖。没有预编译二进制、没有构建步骤、没有安装脚本：340 行纯 ESM 驱动 PowerShell。仅支持 Windows。

## 安装

```sh
dsh plugin --profile web add dsh-popup-notify
```

然后重启，或等 profile 的 patch 层热重载。该 bundle 会插入一行：

```yaml
- insert:
    - id: popup-notify
      name: 'dsh-popup-notify'
```

卸载：`dsh plugin --profile web remove dsh-popup-notify`。

## 为什么用模态框而不是 toast

Windows toast 会自己消失，并堆在通知中心里，很容易错过。当一次运行正卡在**等你**这一步时，一个不点掉就不走的对话框才是这个状态该有的表现。

对话框跑在独立进程，因此从不阻塞 agent 循环。同一时刻只显示一个——后续提醒排队，你关掉当前这个就弹下一个。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖该行的 `config`。patch 会替换整个 `config` 值，所以要把想保留的键一起写出来。

```yaml
- id: popup-notify
  config:
    notifyOnComplete: false
    sound: false
```

### 行为开关

| 键 | 默认值 | 含义 |
|---|---|---|
| `notifyOnApproval` | `true` | 工具请求审批时弹窗。 |
| `notifyOnQuestion` | `true` | `ask_user_question` 或 `exit_plan_mode` 执行时弹窗。 |
| `notifyOnComplete` | `true` | 根 agent 结束一次运行时弹窗。 |
| `ignoreSubagents` | `true` | 静音子 agent、workflow worker、AgentTeams 成员。 |
| `sound` | `true` | 弹窗时播放系统提示音。 |
| `completeCooldownMs` | `10000` | 同一会话两次完成弹窗的最小间隔。 |
| `plainDialog` | `false` | 去掉置顶 owner 窗体。若对话框出现在奇怪位置可启用，代价是可能被其他窗口盖住。 |
| `testOnStart` | `false` | 挂载时弹一次，确认 PowerShell 通路可用。 |
| `traceFile` | `''` | 每次事件与每次弹窗追加一行诊断。留空关闭。 |

### 文案模板

每条文案都是模板，`{placeholder}` 由事件填入；未知占位符原样保留。

| 键 | 默认值 |
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

`{reason}` 是轮次结束原因——正常完成时不出现，否则为 `aborted`、`error`、`max-tokens` 等。`{project}` 是会话工作目录的目录名。把 `projectSuffix` 设为 `''` 可去掉来源行，把 `completeReasonSuffix` 设为 `''` 可不再说明异常结束。

## 挂载在哪

| 扩展点 | 模式 | 用途 |
|---|---|---|
| `approval/request` | waterfall | 弹窗，然后 `next()` 交给已配置的 answerer 决策。 |
| `tools/pre-execute` | waterfall | 匹配 `ask_user_question` 与 `exit_plan_mode`，弹窗，然后 `next()` 让工具执行。 |
| `agent/status` | emit | 根 agent 的 `running` → `idle` 边沿弹窗。 |

DSH 没有提问事件：`ctx.userQuestions.ask()` 是服务调用，待答问题以 mux 帧发给浏览器，宿主插件看不到。在 `tools/pre-execute` 匹配两个提问工具，是**你回答之前**就会触发的可观测点，也正是提醒该响的时刻。

两个 waterfall 都调用 `next()`。不调用的监听器会短路整条链，审批会被解析成 `unavailable`，提问工具根本不会执行。

## 已知限制

- **仅支持 Windows。** 其他平台每条提醒记一条警告后跳过。
- **不是所有审批都会弹。** 审批策略为 `never` 时，服务在分发 `approval/request` 之前就返回 `rejected`，没有任何可观测点。会话审批只在 `ask` 策略下存在。
- **对话框不能点进对话。** 它只报告状态，回答仍在 DSH 窗口里进行。
- **只识别两个提问工具。** 将来若有同样阻塞等人回答的交互工具，需要把名字加进匹配表。
- **同一时刻只有一个对话框。** 长时间离开会让你面前这个后面排起若干条。
- **`plainDialog: true` 失去置顶。** 无 owner 的 MessageBox 可能出现在其他窗口之后。

## 开发

```sh
npm test                      # 22 项单测，不弹任何窗口
node tests/smoke-dialog.mjs   # 打开并关闭一个真实对话框
```

单测注入假的 `spawnDialog`，因此从不接触屏幕。`smoke-dialog.mjs` 是唯一会打开真实窗口的文件。

## 许可证

MIT
