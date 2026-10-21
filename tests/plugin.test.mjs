import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildScript, questionOf, fill, shouldNotify, apply, DEFAULT_CONFIG,
} from '../lib/index.mjs'

/** A fake Cordis context that records listeners, effects, and warnings. */
function fakeCtx() {
  const listeners = new Map()
  const effects = []
  const warnings = []
  return {
    listeners,
    effects,
    warnings,
    logger: { warn: (m) => warnings.push(String(m)) },
    on(event, fn) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn])
      return () => {}
    },
    effect(fn) {
      effects.push(fn())
    },
  }
}

/** Run every listener of one event and return the collected results. */
function emit(ctx, event, ...args) {
  const results = []
  for (const fn of ctx.listeners.get(event) ?? []) results.push(fn(...args))
  return results
}

/** A stand-in child whose exit the test controls. */
function fakeChild(pid = 4242) {
  const child = new EventEmitter()
  child.pid = pid
  return child
}

/** An agent fixture with a session header and optional turn/end history. */
let counter = 0
function agentFixture(header = { cwd: 'D:\\work\\demo' }, events = []) {
  counter += 1
  return { id: `sess-${counter}`, session: { header, events } }
}

/** Build a traced plugin instance whose dialogs are recorded rather than spawned. */
function traced(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-popup-notify-'))
  const traceFile = join(dir, 'trace.log')
  const ctx = fakeCtx()
  const shown = []
  const children = []
  apply(ctx, { traceFile, sound: false, ...options }, {
    spawnDialog: (title, body, config) => {
      shown.push({ title, body, config })
      const child = fakeChild(5000 + children.length)
      children.push(child)
      return child
    },
  })
  const log = () => (existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : '')
  return {
    ctx,
    shown,
    children,
    log,
    /** Close the oldest open dialog so the queue advances. */
    async closeDialog(index = 0) {
      children[index]?.emit('exit', 0)
      await new Promise(r => setImmediate(r))
      await new Promise(r => setImmediate(r))
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('buildScript keeps multi-line bodies and literal special characters', () => {
  const script = buildScript('标题', "it's \"quoted\" $var `tick\nsecond line", { sound: false, plainDialog: false })
  assert.match(script, /'it''s "quoted" \$var `tick\nsecond line'/)
  assert.match(script, /MessageBox\]::Show\(\$owner, /)
  assert.match(script, /Add-Type -AssemblyName System\.Windows\.Forms/)
})

test('buildScript supports the plain fallback without an owner form', () => {
  const script = buildScript('T', 'B', { sound: false, plainDialog: true })
  assert.doesNotMatch(script, /\$owner/)
  assert.match(script, /MessageBox\]::Show\('B', 'T'\)/)
})

test('buildScript emits the sound call only when asked', () => {
  assert.match(buildScript('T', 'B', { sound: true, plainDialog: false }), /SystemSounds\]::Asterisk\.Play/)
  assert.doesNotMatch(buildScript('T', 'B', { sound: false, plainDialog: false }), /SystemSounds/)
})

test('questionOf reports the first question and the total count', () => {
  assert.deepEqual(questionOf({ questions: [{ question: '用哪个？' }] }), { text: '用哪个？', count: 1 })
  assert.deepEqual(questionOf({ questions: [{ question: 'Q1' }, { question: 'Q2' }] }), { text: 'Q1', count: 2 })
  assert.deepEqual(questionOf({}), { text: '', count: 0 })
  assert.deepEqual(questionOf(undefined), { text: '', count: 0 })
})

test('fill substitutes known placeholders and keeps unknown ones', () => {
  assert.equal(fill('a {x} b', { x: 1 }), 'a 1 b')
  assert.equal(fill('a {missing} b', { x: 1 }), 'a {missing} b')
  assert.equal(fill('a {x} b', { x: undefined }), 'a  b')
})

test('shouldNotify mutes subagents and delegated depths', () => {
  assert.equal(shouldNotify(agentFixture({}), true), true)
  assert.equal(shouldNotify(agentFixture({ origin: 'subagent' }), true), false)
  assert.equal(shouldNotify(agentFixture({ delegationDepth: 2 }), true), false)
  assert.equal(shouldNotify(agentFixture({ origin: 'subagent' }), false), true)
})

test('registers exactly the three extension points', () => {
  const t = traced()
  try {
    assert.deepEqual(
      [...t.ctx.listeners.keys()].sort(),
      ['agent/status', 'approval/request', 'tools/pre-execute'],
    )
  } finally {
    t.cleanup()
  }
})

test('questions pop a dialog and the waterfall still delegates', async () => {
  const t = traced()
  try {
    const next = () => Promise.resolve({ kind: 'allow' })
    await emit(t.ctx, 'tools/pre-execute', { name: 'bash', arguments: {}, callId: 'c1', agent: agentFixture() }, next)
    await emit(t.ctx, 'tools/pre-execute', {
      name: 'ask_user_question',
      arguments: { questions: [{ question: '选哪个？' }, { question: '第二个' }] },
      callId: 'c2',
      agent: agentFixture(),
    }, next)

    assert.equal(t.shown.length, 1, 'only the asking tool pops')
    assert.match(t.shown[0].body, /选哪个？/)
    assert.match(t.shown[0].body, /共 2 个问题/)
    assert.match(t.shown[0].body, /项目：demo/)
    assert.match(t.log(), /ask_user_question \(2 question\(s\)\)/)
  } finally {
    t.cleanup()
  }
})

test('plan review pops with its own message', async () => {
  const t = traced()
  try {
    await emit(t.ctx, 'tools/pre-execute', {
      name: 'exit_plan_mode', arguments: { plan: '# P' }, callId: 'c3', agent: agentFixture(),
    }, () => Promise.resolve({ kind: 'allow' }))
    assert.equal(t.shown.length, 1)
    assert.match(t.shown[0].body, /计划等你审阅/)
  } finally {
    t.cleanup()
  }
})

test('subagent questions never pop', async () => {
  const t = traced()
  try {
    await emit(t.ctx, 'tools/pre-execute', {
      name: 'ask_user_question',
      arguments: { questions: [{ question: '不该提醒' }] },
      callId: 'c1',
      agent: agentFixture({ origin: 'subagent' }),
    }, () => Promise.resolve({ kind: 'allow' }))
    assert.equal(t.shown.length, 0)
  } finally {
    t.cleanup()
  }
})

test('approval pops with tool and reason, and still delegates', async () => {
  const t = traced()
  try {
    let delegated = false
    const [outcome] = emit(t.ctx, 'approval/request', {
      toolName: 'bash', reason: 'escalate sandbox', callId: 'call-9', agent: agentFixture(),
    }, () => { delegated = true; return Promise.resolve('unavailable') })

    assert.equal(delegated, true)
    assert.equal(await outcome, 'unavailable')
    assert.equal(t.shown.length, 1)
    assert.match(t.shown[0].body, /bash/)
    assert.match(t.shown[0].body, /escalate sandbox/)
    assert.match(t.log(), /approval\/request: tool=bash/)
  } finally {
    t.cleanup()
  }
})

test('completion fires only on a running→idle edge', async () => {
  const t = traced()
  try {
    const agent = agentFixture({ cwd: 'D:\\work\\demo' }, [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }])
    // An idle observation without a preceding running must stay silent.
    emit(t.ctx, 'agent/status', { agent, status: 'idle' })
    assert.equal(t.shown.length, 0, 'idle without a running edge never notifies')

    emit(t.ctx, 'agent/status', { agent, status: 'running' })
    emit(t.ctx, 'agent/status', { agent, status: 'idle' })
    assert.equal(t.shown.length, 1)
    assert.match(t.shown[0].body, /响应已结束/)
    assert.doesNotMatch(t.shown[0].body, /结束原因/, 'a completed turn carries no reason suffix')
  } finally {
    t.cleanup()
  }
})

test('an abnormal turn end names its reason', () => {
  const t = traced()
  try {
    const agent = agentFixture({}, [{ type: 'turn/end', data: { reason: { kind: 'error' } } }])
    emit(t.ctx, 'agent/status', { agent, status: 'running' })
    emit(t.ctx, 'agent/status', { agent, status: 'idle' })
    assert.match(t.shown[0].body, /结束原因：error/)
  } finally {
    t.cleanup()
  }
})

test('the completion cooldown suppresses a second rapid edge', () => {
  const t = traced({ completeCooldownMs: 60000 })
  try {
    const agent = agentFixture()
    for (const status of ['running', 'idle', 'running', 'idle']) {
      emit(t.ctx, 'agent/status', { agent, status })
    }
    assert.equal(t.shown.length, 1, 'the second completion is inside the cooldown')
    assert.match(t.log(), /suppressed by cooldown/)
  } finally {
    t.cleanup()
  }
})

test('subagent completion never pops', () => {
  const t = traced()
  try {
    const agent = agentFixture({ origin: 'subagent' })
    emit(t.ctx, 'agent/status', { agent, status: 'running' })
    emit(t.ctx, 'agent/status', { agent, status: 'idle' })
    assert.equal(t.shown.length, 0)
  } finally {
    t.cleanup()
  }
})

test('only one dialog is open at a time and the queue drains in order', async () => {
  const t = traced()
  try {
    const agent = agentFixture()
    emit(t.ctx, 'approval/request', { toolName: 'first', callId: 'a', agent }, () => Promise.resolve('unavailable'))
    emit(t.ctx, 'approval/request', { toolName: 'second', callId: 'b', agent }, () => Promise.resolve('unavailable'))
    assert.equal(t.shown.length, 1, 'the second notice waits')

    await t.closeDialog(0)
    assert.equal(t.shown.length, 2, 'the queued notice opens once the first closes')
    assert.match(t.shown[1].body, /second/)
  } finally {
    t.cleanup()
  }
})

test('queued notices with the same key collapse to the newest body', async () => {
  const t = traced()
  try {
    const agent = agentFixture()
    // Hold the queue: the first dialog is on screen, so the next two only queue.
    emit(t.ctx, 'approval/request', { toolName: 'blocker', callId: 'a', agent }, () => Promise.resolve('unavailable'))
    emit(t.ctx, 'approval/request', { toolName: 'older', callId: 'same', agent }, () => Promise.resolve('unavailable'))
    emit(t.ctx, 'approval/request', { toolName: 'newer', callId: 'same', agent }, () => Promise.resolve('unavailable'))
    assert.equal(t.shown.length, 1, 'only the first dialog is open')

    await t.closeDialog(0)
    assert.equal(t.shown.length, 2, 'the collapsed key opens exactly one dialog')
    assert.match(t.shown[1].body, /newer/, 'the newest body wins')
    assert.doesNotMatch(t.shown[1].body, /older/)

    await t.closeDialog(1)
    assert.equal(t.shown.length, 2, 'nothing else was queued behind it')
  } finally {
    t.cleanup()
  }
})

test('each switch turns its own notice off', () => {
  for (const [switchName, event, payload] of [
    ['notifyOnApproval', 'approval/request', { toolName: 'bash', callId: 'x', agent: null }],
    ['notifyOnQuestion', 'tools/pre-execute', { name: 'ask_user_question', arguments: { questions: [{ question: 'Q' }] }, callId: 'y', agent: null }],
    ['notifyOnComplete', 'agent/status', null],
  ]) {
    const t = traced({ [switchName]: false })
    try {
      if (event === 'agent/status') {
        const agent = agentFixture()
        emit(t.ctx, 'agent/status', { agent, status: 'running' })
        emit(t.ctx, 'agent/status', { agent, status: 'idle' })
      } else if (event === 'tools/pre-execute') {
        emit(t.ctx, event, payload, () => Promise.resolve({ kind: 'allow' }))
      } else {
        emit(t.ctx, event, payload, () => Promise.resolve('unavailable'))
      }
      assert.equal(t.shown.length, 0, `${switchName}: false must silence ${event}`)
    } finally {
      t.cleanup()
    }
  }
})

test('disposal stops further dialogs but keeps delegation intact', () => {
  const t = traced()
  try {
    for (const fn of t.ctx.effects) fn()
    let delegated = false
    emit(t.ctx, 'approval/request', { toolName: 'bash', agent: agentFixture() }, () => {
      delegated = true
      return Promise.resolve('unavailable')
    })
    assert.equal(delegated, true)
    assert.equal(t.shown.length, 0)
    assert.match(t.log(), /apply: disposed/)
  } finally {
    t.cleanup()
  }
})

test('testOnStart pops once on load', () => {
  const t = traced({ testOnStart: true })
  try {
    assert.equal(t.shown.length, 1)
    assert.match(t.shown[0].body, /提醒通路正常/)
  } finally {
    t.cleanup()
  }
})

test('a spawn failure is contained and the queue keeps moving', async () => {
  const ctx = fakeCtx()
  const warnings = []
  let calls = 0
  apply(ctx, { sound: false }, {
    spawnDialog: () => {
      calls += 1
      if (calls === 1) throw new Error('powershell missing')
      const child = fakeChild()
      queueMicrotask(() => child.emit('exit', 0))
      return child
    },
  })
  const agent = agentFixture()
  emit(ctx, 'approval/request', { toolName: 'first', callId: 'a', agent }, () => Promise.resolve('unavailable'))
  emit(ctx, 'approval/request', { toolName: 'second', callId: 'b', agent }, () => Promise.resolve('unavailable'))
  await new Promise(r => setTimeout(r, 10))
  assert.equal(calls, 2, 'the failed spawn does not strand the queue')
})

test('every message default is a string', () => {
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (key.endsWith('Message') || key.endsWith('Suffix') || key === 'title') {
      assert.equal(typeof value, 'string', `${key} must be a string`)
    }
  }
})
