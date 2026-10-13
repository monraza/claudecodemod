import { expect, mock, test } from 'claude-code/testing'

const VIEWPORT = { columns: 160, rows: 40 }

// What Claude Code passes to a ui.render hook for the pane, apart from the app.
const PANE = {
  plugin: 'shell-explainer',
  component: 'Pane',
  requestId: 'shell-explainer',
  viewport: VIEWPORT,
  props: {
    title: 'Permissions asked',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// What Claude Code passes for a tool call's row in the transcript.
const row = (id: string, command: string) =>
  ({
    plugin: 'shell-explainer',
    component: 'ToolUse',
    requestId: id,
    viewport: VIEWPORT,
    props: { tool_use_id: id, tool: 'Bash', input: { command }, isRunning: true, isErrored: false, isInterrupted: false },
  }) as const

type Answer = { result?: unknown; text?: string; isError?: true; deny?: string }
type Seen = { notices: { id: string; text: string | undefined }[]; opened: unknown[] }

// Stands in for Claude Code: the verdict the rules reached, the session's folder,
// the clock, the environment, which files exist, its own drawing of a row, and
// how a tool call ends (`answer`).
// Records the notices and the panes opened. There is no toast stub: a toast
// would reject here and the test would see nothing recorded.
function engine(
  on: Parameters<Parameters<typeof test>[1]>[1],
  decision: 'allow' | 'ask' | 'deny',
  {
    existing = [] as string[],
    answer = { result: '', text: 'done' } as Answer,
    files = {} as Record<string, string>,
  } = {},
): Seen {
  const seen: Seen = { notices: [], opened: [] }
  mock.clock(on, { now: Date.UTC(2026, 9, 7, 16, 30, 0) })
  on('tool.check', () => ({ decision, reason: decision === 'ask' ? 'No allow rule matches this command' : undefined }))
  on('tool.call', () => answer)
  on('session.cwd', () => ({ value: '/work' }))
  mock.env(on, { HOME: '/home/me' })
  // e.path arrives absolute and in the platform's spelling, so match the end.
  on('fs.exists', ($, e) => ({ value: existing.some(name => e.path.replace(/\\/g, '/').endsWith(`/${name}`)) }))
  // A file in `files` reads as its text; any other is missing.
  on('fs.read', ($, e) => {
    const name = Object.keys(files).find(one => e.path.replace(/\\/g, '/').endsWith(`/${one}`))
    if (name === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: files[name] }
  })
  on('ui.notice', ($, e) => {
    seen.notices.push({ id: e.tool_use_id, text: e.text })
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    seen.opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['row drawn by Claude Code'] }))
  return seen
}

test('an ask: the banner under the call row, recorded in the pane, which opens once', async ($, on) => {
  const seen = engine(on, 'ask')
  const command = 'git push --force origin main && rm -rf dist'
  const verdict = await $.tool.check({ tool: 'Bash', input: { command }, tool_use_id: 'tu1' })
  expect(verdict.decision).toBe('ask')

  const banner = '🔴 HIGH RISK — force-push: replaces history on the remote (+2 more)'
  expect(seen.notices).toEqual([{ id: 'tu1', text: banner }])
  // Opened by itself, so no focus: it mustn't take the keys from the prompt.
  expect(seen.opened).toEqual([{ id: 'shell-explainer', title: 'Permissions asked' }])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...row('tu1', command), surface })
    expect(await ui.find({ type: 'Text', text: 'row drawn by Claude Code' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: `  ${banner}` })).toBeDefined()
    await ui.unmount()
  }

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // A card: when and how it was answered, the level and reason, the command.
  expect(await pane.find({ type: 'Text', text: '1 asked · 1 waiting' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^\d\d:\d\d:\d\d$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '… waiting' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '🔴 HIGH RISK' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'force-push: replaces history on the remote (+2 more)' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: command })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^─+$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'What it does' })).toBeDefined()
  // While it waits, the breakdown doesn't repeat that it's waiting.
  expect(await pane.find({ type: 'Text', text: /is waiting for you/ })).toBeUndefined()

  // A second ask is recorded; the pane isn't opened again.
  await $.tool.check({ tool: 'Bash', input: { command: 'git push origin main' }, tool_use_id: 'tu2' })
  expect(seen.opened.length).toBe(1)
})

test('every permission is kept, newest first, and any entry can show its breakdown', async ($, on) => {
  engine(on, 'ask')
  await $.tool.check({ tool: 'Bash', input: { command: 'git push origin main' }, tool_use_id: 'tu1' })
  await $.tool.check({ tool: 'PowerShell', input: { command: 'Remove-Item -Recurse -Force dist' }, tool_use_id: 'tu2' })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: '2 asked · 2 waiting' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'PowerShell: Remove-Item -Recurse -Force dist' })).toBeDefined()
  // The newest shows its breakdown; the older one doesn't yet.
  expect(await pane.find({ type: 'Text', text: /^deletes dist$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^uploads commits/ })).toBeUndefined()

  await pane.press({ key: 'toggle-tu1' })
  expect(await pane.find({ type: 'Text', text: /^uploads commits/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^deletes dist$/ })).toBeUndefined()

  // Hide it again: no breakdown open.
  await pane.press({ key: 'toggle-tu1' })
  expect(await pane.find({ type: 'Text', text: 'What it does' })).toBeUndefined()
})

// The ask is recorded at tool.check; the call with the same id then ends.
async function askThenEnd($: Parameters<Parameters<typeof test>[1]>[0]) {
  await $.tool.check({ tool: 'Bash', input: { command: 'rm notes.txt' }, tool_use_id: 'tu9' })
  await $.tool.call({ tool: 'Bash', command: 'rm notes.txt', tool_use_id: 'tu9' } as never)
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}

test('what happened next is recorded: ran, flagged approved', async ($, on) => {
  engine(on, 'ask', { answer: { result: '', text: 'done' } })
  const pane = await askThenEnd($)
  expect(await pane.find({ type: 'Text', text: '✓ approved' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '1 asked · 1 approved' })).toBeDefined()
})

test('what happened next is recorded: you said no, flagged denied', async ($, on) => {
  engine(on, 'ask', { answer: { deny: "The user doesn't want to proceed with this tool use." } })
  const pane = await askThenEnd($)
  expect(await pane.find({ type: 'Text', text: '✗ denied' })).toBeDefined()
})

test('what happened next is recorded: ran with an error, still approved', async ($, on) => {
  engine(on, 'ask', { answer: { result: '', text: 'exit code 1', isError: true } })
  const pane = await askThenEnd($)
  expect(await pane.find({ type: 'Text', text: '✓ approved · ended with an error' })).toBeDefined()
})

test('the pane flags each entry and counts them: waiting, approved, denied', async ($, on) => {
  // The engine answers every call with this object, changed between calls.
  const answer: Answer = { result: '', text: 'done' }
  engine(on, 'ask', { answer })
  await $.tool.check({ tool: 'Bash', input: { command: 'rm a.txt' }, tool_use_id: 'a' })
  await $.tool.call({ tool: 'Bash', command: 'rm a.txt', tool_use_id: 'a' } as never)
  delete answer.result
  delete answer.text
  answer.deny = "The user doesn't want to proceed with this tool use."
  await $.tool.check({ tool: 'Bash', input: { command: 'rm b.txt' }, tool_use_id: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'rm b.txt', tool_use_id: 'b' } as never)
  await $.tool.check({ tool: 'Bash', input: { command: 'rm c.txt' }, tool_use_id: 'c' })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: '3 asked · 1 waiting · 1 approved · 1 denied' })).toBeDefined()
  for (const flag of ['… waiting', '✓ approved', '✗ denied']) expect(await pane.find({ type: 'Text', text: flag })).toBeDefined()
})

// Claude Code's own record of a permission decision, as the collector gets it.
const decision = (id: string, source: string, verdict = 'accept') => ({
  to: 'collector' as const,
  event: 'tool_decision',
  attributes: { tool_name: 'Bash', tool_use_id: id, decision: verdict, source, tool_source: 'builtin' },
  loggedAt: '2026-10-07T16:30:00.000Z',
})

test('(auto) marks only what the classifier decided; what you answered stays plain, even in auto mode', async ($, on) => {
  const answer: Answer = { result: '', text: 'done' }
  engine(on, 'ask', { answer })
  on('telemetry.log', () => ({ value: undefined }))

  // The classifier said yes.
  await $.tool.check({ tool: 'Bash', input: { command: 'rm a.txt' }, tool_use_id: 'a' })
  await $.telemetry.log(decision('a', 'config'))
  await $.tool.call({ tool: 'Bash', command: 'rm a.txt', tool_use_id: 'a' } as never)
  // It handed this one to you, and you said yes.
  await $.tool.check({ tool: 'Bash', input: { command: 'rm b.txt' }, tool_use_id: 'b' })
  await $.telemetry.log(decision('b', 'user_temporary'))
  await $.tool.call({ tool: 'Bash', command: 'rm b.txt', tool_use_id: 'b' } as never)
  // The classifier said no.
  delete answer.result
  delete answer.text
  answer.deny = 'Permission for this action was denied by auto mode.'
  await $.tool.check({ tool: 'Bash', input: { command: 'rm c.txt' }, tool_use_id: 'c' })
  await $.telemetry.log(decision('c', 'classifier', 'reject'))
  await $.tool.call({ tool: 'Bash', command: 'rm c.txt', tool_use_id: 'c' } as never)
  // No record at all: no guess.
  answer.deny = 'Refused.'
  await $.tool.check({ tool: 'Bash', input: { command: 'rm d.txt' }, tool_use_id: 'd' })
  await $.tool.call({ tool: 'Bash', command: 'rm d.txt', tool_use_id: 'd' } as never)

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.findAll({ type: 'Text', text: /^✓ approved \(auto\)$/ })).toHaveLength(1)
  expect(await pane.findAll({ type: 'Text', text: /^✓ approved$/ })).toHaveLength(1)
  expect(await pane.findAll({ type: 'Text', text: /^✗ denied \(auto\)$/ })).toHaveLength(1)
  expect(await pane.findAll({ type: 'Text', text: /^✗ denied$/ })).toHaveLength(1)
  expect(await pane.find({ type: 'Text', text: '4 asked · 2 approved · 2 denied' })).toBeDefined()

  // The breakdown names who decided, in Claude Code's own word.
  await pane.press({ key: 'toggle-b' })
  expect(await pane.find({ type: 'Text', text: 'you, at the dialog (user_temporary)' })).toBeDefined()
  await pane.press({ key: 'toggle-a' })
  expect(await pane.find({ type: 'Text', text: "auto mode's classifier (config)" })).toBeDefined()
})

test("a decision record about a call that wasn't asked changes nothing", async ($, on) => {
  engine(on, 'ask')
  on('telemetry.log', () => ({ value: undefined }))
  await $.tool.check({ tool: 'Bash', input: { command: 'rm a.txt' }, tool_use_id: 'a' })
  await $.telemetry.log(decision('other', 'classifier'))
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /Decided by/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '… waiting' })).toBeDefined()
})

test('an entry still waiting when the mod reloads says its outcome was lost, not "waiting" forever', async ($, on) => {
  engine(on, 'ask')
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf dist' }, tool_use_id: 'r1' })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: '? not recorded (the mod reloaded)' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '1 asked · 1 unknown' })).toBeDefined()
})

test('the breakdown reads in sections: each step its command, what it does, and how it follows', async ($, on) => {
  engine(on, 'ask')
  const command = 'sed -n 1,5p a.ts && claude plugin validate . 2>&1 | tail -2; rm -rf out'
  await $.tool.check({ tool: 'Bash', input: { command, description: 'Check the hooks' }, tool_use_id: 's1' })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await pane.find({ type: 'Text', text: '“Check the hooks”' })).toBeDefined()
  for (const title of ['What it does', 'Worth a look', 'Why it asked']) expect(await pane.find({ type: 'Text', text: title })).toBeDefined()
  // Step 2: its number, its command, what it does, and how it follows step 1.
  expect(await pane.find({ type: 'Text', text: '2.' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^claude plugin validate \.$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'runs Claude Code' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '↳ only if 1 worked' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: "↳ reads 2's output" })).toBeDefined()
  // A risk: its mark in a column of its own, the text beside it.
  expect(await pane.find({ type: 'Text', text: '!!' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^deletes out and everything inside/ })).toBeDefined()
  // Nothing of the old one-line form is left.
  expect(await pane.find({ type: 'Text', text: /then, if that worked:|its output goes to:/ })).toBeUndefined()
})

test('risky only hides the answered green and blue entries, and shows them again', async ($, on) => {
  engine(on, 'ask')
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'safe' })
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'safe' } as never)
  await $.tool.check({ tool: 'Bash', input: { command: 'mkdir out' }, tool_use_id: 'low' })
  await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf dist' }, tool_use_id: 'high' })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf dist', tool_use_id: 'high' } as never)

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'risky-only' })
  expect(await pane.find({ type: 'Text', text: 'showing 2 of 3 · risky only' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'ls' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'mkdir out' })).toBeDefined() // still waiting
  expect(await pane.find({ type: 'Text', text: 'rm -rf dist' })).toBeDefined()

  await pane.press({ key: 'risky-only' })
  expect(await pane.find({ type: 'Text', text: '3 asked · 1 waiting · 2 approved' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'ls' })).toBeDefined()
})

test('paths read from the project: its folder is ".", and cd into it is dropped', async ($, on) => {
  const seen = engine(on, 'ask', { answer: { result: '', text: 'done' } })
  const command = 'cd "/work" && rm -rf /work/dist /home/me/cache'
  await $.tool.check({ tool: 'Bash', input: { command }, tool_use_id: 'p1' })
  expect(seen.notices[0]?.text).toBe('🔴 HIGH RISK — deletes ./dist, ~/cache and everything inside, without asking (+1 more)')
  await $.tool.call({ tool: 'Bash', command, tool_use_id: 'p1' } as never)

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: 'rm -rf ./dist ~/cache' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /\/work/ })).toBeUndefined()
  // Once it has run, the breakdown doesn't say it's waiting.
  expect(await pane.find({ type: 'Text', text: /is waiting for you/ })).toBeUndefined()
})

test('once the call is answered, the banner leaves the transcript and stays in the pane', async ($, on) => {
  engine(on, 'ask', { answer: { deny: "The user doesn't want to proceed with this tool use." } })
  const command = 'rm -rf dist'
  await $.tool.check({ tool: 'Bash', input: { command }, tool_use_id: 'tu10' })
  const group = {
    plugin: 'shell-explainer',
    component: 'ToolGroup',
    requestId: 'g2',
    viewport: VIEWPORT,
    props: { calls: [{ tool_use_id: 'tu10', tool: 'Bash', input: { command }, isRunning: false, isErrored: false, isInterrupted: false }], isActive: false, isExpanded: false },
  } as const
  const banner = /^ {2}🔴 HIGH RISK/
  const ui = await $.ui.mount({ ...row('tu10', command), surface: 'terminal' })
  const folded = await $.ui.mount({ ...group, surface: 'terminal' })
  const rule = /^ {2}─+$/
  expect(await ui.find({ type: 'Text', text: banner })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: rule })).toHaveLength(2) // above and below
  expect(await folded.find({ type: 'Text', text: banner })).toBeDefined()
  expect(await folded.findAll({ type: 'Text', text: rule })).toHaveLength(2)

  await $.tool.call({ tool: 'Bash', command, tool_use_id: 'tu10' } as never)
  expect(await ui.find({ type: 'Text', text: banner })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: rule })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'row drawn by Claude Code' })).toBeDefined()
  expect(await folded.find({ type: 'Text', text: banner })).toBeUndefined()

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: '🔴 HIGH RISK' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '✗ denied' })).toBeDefined()
})

test('a folded group of shell calls gets the banner of its rated call', async ($, on) => {
  engine(on, 'ask')
  const command = 'Remove-Item -LiteralPath C:\\work\\hello -Confirm:$false'
  await $.tool.check({ tool: 'PowerShell', input: { command }, tool_use_id: 'tu7' })
  const call = (id: string, tool: string) => ({ tool_use_id: id, tool, input: { command }, isRunning: true, isErrored: false, isInterrupted: false })
  const group = {
    plugin: 'shell-explainer',
    component: 'ToolGroup',
    requestId: 'g1',
    viewport: VIEWPORT,
    props: { calls: [call('tu-read', 'Read'), call('tu7', 'PowerShell')], isActive: true, isExpanded: false },
  } as const
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...group, surface })
    expect(await ui.find({ type: 'Text', text: 'row drawn by Claude Code' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ {2}🟡 NEEDS YOUR ATTENTION — deletes C:\\work\\hello/ })).toBeDefined()
    await ui.unmount()
  }
})

test('rows of calls that were not asked about are drawn as Claude Code draws them', async ($, on) => {
  engine(on, 'ask')
  const ui = await $.ui.mount({ ...row('tu-other', 'ls'), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'row drawn by Claude Code' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /RISK|SAFE|ATTENTION/ })).toBeUndefined()
})

test('allowed or denied calls never reach a dialog, so nothing is recorded', async ($, on) => {
  const seen = engine(on, 'allow')
  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf dist' }, tool_use_id: 'tu3' })
  expect(verdict.decision).toBe('allow')
  expect(seen.notices).toEqual([])
  expect(seen.opened).toEqual([])
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /No shell command has asked/ })).toBeDefined()
})

test('a query with no tool call behind it is left alone', async ($, on) => {
  const seen = engine(on, 'ask')
  await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf dist' } })
  expect(seen.notices).toEqual([])
  expect(seen.opened).toEqual([])
})

test('a redirect into a file that exists is an overwrite; into a new one, not', async ($, on) => {
  const seen = engine(on, 'ask', { existing: ['notes.md'] })
  await $.tool.check({ tool: 'Bash', input: { command: 'echo hi > notes.md' }, tool_use_id: 'tu4' })
  await $.tool.check({ tool: 'Bash', input: { command: 'echo hi > fresh.md' }, tool_use_id: 'tu5' })
  expect(seen.notices[0]?.text).toBe('🟡 NEEDS YOUR ATTENTION — overwrites notes.md')
  expect(seen.notices[1]?.text).toBe('🔵 LOW RISK — makes ordinary changes inside this project')
})

test('a script is rated by what it holds, read through $.fs, a script inside it too', async ($, on) => {
  const seen = engine(on, 'ask', {
    files: {
      'package.json': JSON.stringify({ scripts: { build: 'tsc && ./scripts/publish.sh' } }),
      'scripts/publish.sh': '#!/bin/sh\ngit push --force origin main\n',
    },
  })
  await $.tool.check({ tool: 'Bash', input: { command: 'npm run build' }, tool_use_id: 'tu6' })
  expect(seen.notices[0]?.text).toBe('🔴 HIGH RISK — publish.sh: force-push: replaces history on the remote (+1 more)')

  // A script that can't be read is said so, never played down.
  await $.tool.check({ tool: 'Bash', input: { command: './deploy.sh' }, tool_use_id: 'tu8' })
  expect(seen.notices[1]?.text).toBe("🟡 NEEDS YOUR ATTENTION — runs deploy.sh, which couldn't be read")
})

test('/shell-explainer opens the pane with focus, at any width', async ($, on) => {
  const seen = engine(on, 'ask')
  const answer = await $.command.run({ command: 'shell-explainer', args: '' })
  expect(answer).toEqual({})
  expect(seen.opened).toEqual([{ id: 'shell-explainer', title: 'Permissions asked', focus: true, closeOnEscape: true }])
})
