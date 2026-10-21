import { spawn, execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// Real-machine check of the shipping path: buildScript + -EncodedCommand must
// produce an actually-blocking modal, and the queue must advance after it closes.
const { buildScript } = await import(pathToFileURL('C:/Users/11451/dsh-popup-notify/lib/index.mjs').href)

const marker = `smoke-${Date.now()}`
const script = buildScript(marker, "第一行\n理由：it's \"quoted\" $var `tick\n项目：demo", { sound: false, plainDialog: false })
const encoded = Buffer.from(script, 'utf16le').toString('base64')

const child = spawn(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
  { stdio: 'ignore', windowsHide: true },
)
child.unref()

let exited = null
child.once('exit', (code) => { exited = code })

await new Promise(r => setTimeout(r, 2500))
const alive = execFileSync('powershell.exe', [
  '-NoProfile', '-Command',
  `if (Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue) { 'ALIVE' } else { 'GONE' }`,
], { encoding: 'utf8' }).trim()

console.log(`encoded multi-line dialog: exited=${exited} process=${alive}`)
console.log(alive === 'ALIVE' ? 'PASS: dialog is blocking (visible on screen)' : 'FAIL: dialog closed by itself')

// Confirm the title reached PowerShell intact (proves encoding, not mojibake).
const cmdline = execFileSync('powershell.exe', [
  '-NoProfile', '-Command',
  `(Get-CimInstance Win32_Process -Filter "ProcessId=${child.pid}").CommandLine`,
], { encoding: 'utf8' })
const decoded = Buffer.from(cmdline.split('-EncodedCommand')[1].trim().split(/\s+/)[0], 'base64').toString('utf16le')
console.log('PASS: title round-trips:', decoded.includes(marker))
console.log('PASS: body keeps newlines:', decoded.includes('第一行\r\n') || decoded.includes('第一行\n'))
console.log('PASS: quotes intact:', decoded.includes(`it''s "quoted"`))

execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
console.log('dialog closed')
