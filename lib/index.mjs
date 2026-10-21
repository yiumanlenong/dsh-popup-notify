/**
 * dsh-popup-notify —— DeepSeek Harness 的桌面弹窗提醒插件。
 *
 * 三种会把控制权交回给你的时刻各弹一个置顶模态对话框（Windows / PowerShell）：
 *
 *   1. 需要权限  —— 工具请求审批（`approval/request`）
 *   2. 需要选择  —— 模型提问（`ask_user_question`）或提交计划待审阅（`exit_plan_mode`）
 *   3. 任务完成  —— 一个根 agent 从 running 落到 idle（`agent/status`）
 *
 * 与常见的 toast 通知不同，这里用的是**模态对话框**：不点掉就一直挡在最前面，
 * 不会几秒后自己消失。对话框跑在独立进程里，不阻塞 agent 回合；同一时刻只显示
 * 一个，后面的排队，关掉当前这个再弹下一个。
 *
 * 只依赖 Node 内置模块，没有任何 npm 依赖、没有预编译二进制、没有构建步骤。
 *
 * @module dsh-popup-notify
 */

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'

/** 插件名（Loader 用它做日志与条目标识）。 */
export const name = 'dsh-popup-notify'

/** 本插件只用 Cordis 事件，不注入任何服务。 */
export const inject = []

/** 可被 patch 覆盖的默认值。 */
export const DEFAULT_CONFIG = {
  /** 对话框标题。 */
  title: 'DeepSeek Harness',
  /** 审批提醒正文，`{tool}` 换成工具名。 */
  approvalMessage: '工具 {tool} 需要你的权限确认',
  /** 审批带理由时的后缀，`{reason}` 换成模型给的理由。 */
  approvalReasonSuffix: '\n\n理由：{reason}',
  /** 提问提醒正文，`{question}` 换成第一句问题。 */
  questionMessage: '需要你的回答：{question}',
  /** 多问题时的后缀，`{count}` 换成问题总数。 */
  questionCountSuffix: '\n\n（共 {count} 个问题，请在对话里逐个回答）',
  /** 计划审阅提醒正文。 */
  planReviewMessage: '有一份计划等你审阅：批准，或继续规划。',
  /** 完成提醒正文。 */
  completeMessage: 'Agent 响应已结束，可以查看结果了。',
  /** 完成提醒在非正常结束时的后缀，`{reason}` 换成 aborted / error / max-tokens 等。 */
  completeReasonSuffix: '\n\n（结束原因：{reason}）',
  /** 来源标注，`{project}` 换成会话工作目录名。留空字符串可关闭。 */
  projectSuffix: '\n\n项目：{project}',

  /** 是否在审批请求时提醒。 */
  notifyOnApproval: true,
  /** 是否在提问 / 计划审阅时提醒。 */
  notifyOnQuestion: true,
  /** 是否在一次运行结束时提醒。 */
  notifyOnComplete: true,

  /**
   * 子 agent 的提醒是否静音。默认 true：后台委派、workflow worker、
   * AgentTeams 成员的完成不该打断你。
   */
  ignoreSubagents: true,

  /** 弹窗时播放系统提示音。 */
  sound: true,

  /** 同一会话两次完成提醒的最小间隔（毫秒），避免密集交互时反复弹。 */
  completeCooldownMs: 10000,

  /**
   * 为 true 时改用不带 owner 窗体的朴素 MessageBox。极少数机器上置顶 owner
   * 的写法可能把对话框放到奇怪的位置，用它兜底（代价是不保证跑到最前）。
   */
  plainDialog: false,

  /** 挂载时立刻弹一次，用来确认 PowerShell 通路可用。 */
  testOnStart: false,

  /** 诊断日志文件路径；留空表示不写。排查“到底有没有触发”时用。 */
  traceFile: '',
}

/**
 * 会把控制权交给用户的工具：模型调它们时就是在等你做选择。
 * `ask_user_question` 是通用提问，`exit_plan_mode` 是计划审阅。
 */
const ASKING_TOOLS = new Map([
  ['ask_user_question', 'question'],
  ['exit_plan_mode', 'plan-review'],
])

/**
 * 把文本包成 PowerShell 单引号字符串字面量（内部单引号翻倍转义）。
 * @param {unknown} text 任意文本。
 * @returns {string} 可内联进 PowerShell 的字面量。
 */
function psLiteral(text) {
  return `'${String(text ?? '').replace(/'/g, "''")}'`
}

/**
 * 组装弹出的 PowerShell 脚本：隐形置顶 owner 窗体 + MessageBox。
 *
 * owner 窗体只让对话框获得前台权限并居中，自身 1x1 且全透明。正文用单引号字面量
 * 携带，因此 `$`、反引号、双引号都是普通字符；换行由字面量里的真实换行表示。
 *
 * @param {string} title 对话框标题。
 * @param {string} body 对话框正文；换行会保留成真正的多行。
 * @param {{ sound?: boolean, plainDialog?: boolean }} options 声音与兜底模式。
 * @returns {string} 单条 PowerShell 脚本（换行分隔）。
 */
export function buildScript(title, body, options) {
  const sound = options.sound ? ['try { [System.Media.SystemSounds]::Asterisk.Play() } catch {}'] : []
  const show = options.plainDialog
    ? [`[void][System.Windows.Forms.MessageBox]::Show(${psLiteral(body)}, ${psLiteral(title)})`]
    : [
        '$owner = New-Object System.Windows.Forms.Form',
        '$owner.TopMost = $true',
        '$owner.ShowInTaskbar = $false',
        '$owner.FormBorderStyle = "None"',
        '$owner.StartPosition = "CenterScreen"',
        '$owner.Width = 1',
        '$owner.Height = 1',
        '$owner.Opacity = 0',
        '$owner.Show()',
        '$owner.Activate()',
        ...sound,
        `[void][System.Windows.Forms.MessageBox]::Show($owner, ${psLiteral(body)}, ${psLiteral(title)})`,
        '$owner.Close()',
      ]
  return ['Add-Type -AssemblyName System.Windows.Forms', ...show].join('\n')
}

/**
 * 启动一个显示对话框的 PowerShell 进程。
 *
 * 正文经 `-EncodedCommand` 以 UTF-16LE base64 传递：不经过 argv 的引号转义与
 * 控制台代码页转换，多行与任意引号都能原样到达。
 *
 * 进程**不能** detached：实测 detach 出去的 PowerShell 没有可交互窗口站，
 * MessageBox 会立刻返回、看不见窗口。`unref` 只把子进程从事件循环引用计数里
 * 摘掉，宿主退出不受阻。
 *
 * @param {string} title 对话框标题。
 * @param {string} body 对话框正文。
 * @param {typeof DEFAULT_CONFIG} config 生效配置。
 * @returns {import('node:child_process').ChildProcess} 已启动的子进程。
 */
export function spawnDialog(title, body, config) {
  const encoded = Buffer.from(buildScript(title, body, config), 'utf16le').toString('base64')
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    { stdio: 'ignore', windowsHide: true },
  )
  child.unref()
  return child
}

/**
 * 读取会话工作目录的目录名，用于在多会话场景下区分提醒来源。
 * @param {any} session 会话对象（可能不存在）。
 * @returns {string} 目录名；拿不到时为空串。
 */
function projectOf(session) {
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? basename(cwd) : ''
}

/**
 * 是否为需要提醒的根 agent：子 agent、workflow worker 等后台委派默认静音。
 * @param {any} agent 候选 agent。
 * @param {boolean} ignoreSubagents 是否静音子 agent。
 * @returns {boolean} true 表示该 agent 的提醒应当弹出。
 */
export function shouldNotify(agent, ignoreSubagents) {
  if (!ignoreSubagents) return true
  const header = agent?.session?.header
  if (header?.origin === 'subagent') return false
  if (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0) return false
  return true
}

/**
 * 从 `ask_user_question` 的参数里取出第一句问题。
 * @param {unknown} args 工具参数。
 * @returns {{ text: string, count: number }} 首句问题与问题总数。
 */
export function questionOf(args) {
  const questions = args?.questions
  if (!Array.isArray(questions) || questions.length === 0) return { text: '', count: 0 }
  const first = questions[0]
  const text = typeof first?.question === 'string' && first.question.length > 0 ? first.question : ''
  return { text, count: questions.length }
}

/**
 * 用 `{name}` 占位符填一段模板；未知占位符原样保留，值为 undefined 时替换成空串。
 * @param {string} template 模板文本。
 * @param {Record<string, string | number | undefined>} values 占位符取值。
 * @returns {string} 填写后的文本。
 */
export function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (whole, key) => {
    if (!Object.hasOwn(values, key)) return whole
    const value = values[key]
    return value === undefined ? '' : String(value)
  })
}

/**
 * 插件主体：注册三个事件监听并维护一个弹窗队列。
 *
 * @param {any} ctx Cordis 上下文。
 * @param {Partial<typeof DEFAULT_CONFIG> | undefined} rawConfig patch 行里的 config。
 * @param {{ spawnDialog?: typeof spawnDialog }} [deps] 测试替身；生产调用从不传它。
 * @returns {void}
 */
export function apply(ctx, rawConfig, deps = {}) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }
  const show = deps.spawnDialog ?? spawnDialog

  let disposed = false
  /** 是否已有一个对话框进程在场（MessageBox 是模态的，同一时刻只该有一个）。 */
  let showing = false
  /** 排队中的提醒；Map 保序，同键只保留最新正文。 */
  const pending = new Map()
  /** 每个会话上一次完成提醒的时间戳，用于 completeCooldownMs。 */
  const lastCompleteAt = new Map()
  /** 每个 agent 上一次观察到的状态；只有 running→idle 才算“任务完成”。 */
  const lastStatus = new Map()

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`${name}: ${message}`)
    } catch {
      // 日志服务不可用时静默：提醒功能本身不该因为日志失败而中断。
    }
  }

  /** 诊断追踪：traceFile 为空时是 no-op，写失败也绝不影响提醒。 */
  const trace = (message) => {
    if (typeof config.traceFile !== 'string' || config.traceFile.length === 0) return
    try {
      appendFileSync(config.traceFile, `${new Date().toISOString()} ${message}\n`)
    } catch {
      // 追踪只是诊断，磁盘不可写时静默放弃。
    }
  }

  trace(`apply: loaded (platform=${process.platform})`)

  ctx.effect(() => () => {
    // 卸载只停止后续排队；已经弹出的对话框留给用户自己关。
    disposed = true
    pending.clear()
    lastCompleteAt.clear()
    lastStatus.clear()
    trace('apply: disposed')
  })

  /** 取来源后缀；projectSuffix 为空或拿不到目录时返回空串。 */
  const tailFor = (session) => {
    if (typeof config.projectSuffix !== 'string' || config.projectSuffix.length === 0) return ''
    const project = projectOf(session)
    return project.length === 0 ? '' : fill(config.projectSuffix, { project })
  }

  /** 弹队列头部的一条提醒；该进程退出后再继续下一个。 */
  function drain() {
    if (disposed) {
      showing = false
      pending.clear()
      return
    }
    const head = pending.values().next()
    if (head.done) {
      showing = false
      return
    }
    const notice = head.value
    pending.delete(notice.key)
    showing = true

    if (process.platform !== 'win32') {
      warn('desktop popups are Windows-only; notification skipped')
      showing = false
      queueMicrotask(drain)
      return
    }

    let child
    try {
      child = show(notice.title, notice.body, config)
    } catch (error) {
      warn(`failed to spawn powershell: ${String(error)}`)
      trace(`spawn threw: ${String(error)}`)
      showing = false
      queueMicrotask(drain)
      return
    }
    trace(`spawned dialog pid=${child.pid} key=${notice.key}`)
    child.once('error', (error) => {
      warn(`powershell failed: ${String(error)}`)
      trace(`child error: ${String(error)}`)
      showing = false
      queueMicrotask(drain)
    })
    child.once('exit', (code) => {
      trace(`dialog closed pid=${child.pid} code=${code}`)
      showing = false
      queueMicrotask(drain)
    })
  }

  /**
   * 排入一条提醒。
   * @param {string} key 去重键；同键重复提醒只保留最新正文。
   * @param {string} body 对话框正文。
   */
  function enqueue(key, body) {
    if (disposed) return
    pending.set(key, { key, title: config.title, body })
    if (!showing) drain()
  }

  // --- 需要选择：模型调用会交还控制权的工具时提醒。
  // DSH 没有“提问”事件（`ctx.userQuestions.ask()` 是服务调用而非事件），所以挂在
  // `tools/pre-execute` 上按工具名识别：ask_user_question = 提问，
  // exit_plan_mode = 计划审阅。两者都会阻塞在这一步直到你回答。
  // waterfall 必须 next()，否则工具根本不会执行。
  ctx.on('tools/pre-execute', (exec, next) => {
    const kind = ASKING_TOOLS.get(exec?.name)
    if (kind === undefined || !config.notifyOnQuestion) return next()
    if (!shouldNotify(exec.agent, config.ignoreSubagents)) return next()
    const tail = tailFor(exec.agent?.session)
    if (kind === 'plan-review') {
      trace('pre-execute: exit_plan_mode')
      enqueue('plan-review', `${config.planReviewMessage}${tail}`)
    } else {
      const { text, count } = questionOf(exec.arguments)
      const body = fill(config.questionMessage, { question: text || '模型在等你回答' })
        + (count > 1 ? fill(config.questionCountSuffix, { count }) : '')
        + tail
      trace(`pre-execute: ask_user_question (${count} question(s))`)
      enqueue(`question:${exec.callId ?? text}`, body)
    }
    return next()
  })

  // --- 需要权限：审批请求到达时提醒。
  // waterfall 必须 next() 交回后续 answerer，否则审批会被解析成 unavailable
  // （失败关闭）。审批策略为 never 时这里根本不会触发——那是服务端在分发之前
  // 就短路了，不是本插件的问题。
  ctx.on('approval/request', (request, next) => {
    if (config.notifyOnApproval && shouldNotify(request?.agent, config.ignoreSubagents)) {
      const tool = typeof request?.toolName === 'string' && request.toolName.length > 0 ? request.toolName : '未知工具'
      const reason = typeof request?.reason === 'string' && request.reason.length > 0 ? request.reason : undefined
      const body = fill(config.approvalMessage, { tool })
        + (reason === undefined ? '' : fill(config.approvalReasonSuffix, { reason }))
        + tailFor(request?.agent?.session)
      trace(`approval/request: tool=${tool}`)
      enqueue(`approval:${request?.callId ?? request?.toolName ?? 'unknown'}`, body)
    }
    return next()
  })

  // --- 任务完成：agent 从 running 落到 idle 的那一次。
  // 维护性 idle（压缩、定时任务等）不产生状态翻转，因此不会误报；这里再显式只认
  // running→idle，不依赖上游是否只在翻转时发事件。
  ctx.on('agent/status', ({ agent, status }) => {
    const id = agent?.id ?? 'unknown'
    const previous = lastStatus.get(id)
    lastStatus.set(id, status)
    if (!config.notifyOnComplete || status !== 'idle' || previous !== 'running') return
    if (!shouldNotify(agent, config.ignoreSubagents)) return
    const now = Date.now()
    const last = lastCompleteAt.get(id)
    if (last !== undefined && now - last < config.completeCooldownMs) {
      trace(`agent/status: idle for ${id} suppressed by cooldown`)
      return
    }
    lastCompleteAt.set(id, now)
    const session = agent?.session
    const lastTurn = session?.events?.findLast?.((event) => event.type === 'turn/end')
    const reason = lastTurn?.data?.reason?.kind
    const body = config.completeMessage
      + (typeof reason === 'string' && reason !== 'completed' ? fill(config.completeReasonSuffix, { reason }) : '')
      + tailFor(session)
    trace(`agent/status: idle session=${id} reason=${String(reason ?? 'none')}`)
    enqueue(`done:${id}`, body)
  })

  if (config.testOnStart) {
    // 自检通路：patch 热重载即弹一次；改回 false 再保存即不再自检。
    trace('testOnStart: enqueue self-test')
    enqueue('self-test', '插件已挂载，提醒通路正常。\n\n把 config 里的 testOnStart 改回 false 即不再自检。')
  }
}
