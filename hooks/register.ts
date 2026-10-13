// shell-explainer: when Claude Code is about to ask permission for a Bash or
// PowerShell command, it says what the command does and how risky it is.
//   - a colored banner under the command's line in the transcript, which sits
//     right above the permission dialog, while the dialog waits. That line is
//     usually a folded ToolGroup, or a ToolUse row when calls are drawn one
//     per row.
//   - a pane that records every permission asked this session: the rating, the
//     command, when, what happened next, and the full breakdown. It opens by
//     itself at the first one (shown from 144 columns; /shell-explainer opens
//     it at any width).
// The dialog itself is Claude Code's alone: a mod can't draw inside it. Its
// documented hook, $.ui.notice, is still called, though v2.1.292's terminal
// draws nothing for it under a shell command's dialog.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ThemeKey } from 'claude-code'

import { assessPermission } from '../lib/explain.js'
import type { AssessInput, Assessment, RiskLevel } from '../lib/explain.js'
import type { Entry } from '../types'

const PANE = 'shell-explainer'
const PANE_TITLE = 'Permissions asked'
const SHELLS = ['Bash', 'PowerShell']
const MAX_ENTRIES = 100
// Rating passes: each can read the files the one before found (a script that runs a script).
const MAX_PASSES = 5
const COLORS: Record<RiskLevel, ThemeKey> = { safe: 'success', low: 'suggestion', attention: 'warning', high: 'error' }

const history = atom({ plugin: 'shell-explainer', key: 'history' } as const, [])
const selected = atom({ plugin: 'shell-explainer', key: 'selected' } as const, null)
const riskyOnly = atom({ plugin: 'shell-explainer', key: 'riskyOnly' } as const, false)

// A rating depends on files: whether a path exists ("overwrites X" or "a new
// file X"), and what a script about to run holds (package.json's scripts,
// ./deploy.sh). A mod has no synchronous file system, so each pass collects the
// paths it needed and $.fs answers them for the next, until a pass asks nothing
// new: a script can run another script. A path it can't check counts as there,
// and a file it can't read as unreadable, so a risk is never played down.
async function rate($: EngineInterface, tool: string, input: unknown, why: string | undefined): Promise<Assessment | null> {
  const toolInput = input as AssessInput['tool_input']
  if (typeof toolInput?.command !== 'string') return null
  const cwd = await $.session.cwd()
  const homedir = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const call: AssessInput = { tool_name: tool, tool_input: toolInput, cwd }

  const found = new Map<string, boolean>()
  const texts = new Map<string, string | null>()
  for (let pass = 1; ; pass++) {
    const exists = new Set<string>()
    const reads = new Set<string>()
    const rated = assessPermission(call, {
      homedir,
      why,
      exists: path => found.get(path) ?? (exists.add(path), true),
      read: path => (texts.has(path) ? (texts.get(path) ?? null) : (reads.add(path), null)),
    })
    if ((exists.size === 0 && reads.size === 0) || pass === MAX_PASSES) return rated
    await Promise.all([
      ...[...exists].map(async path => found.set(path, await $.fs.exists(path).catch(() => true))),
      ...[...reads].map(async path => texts.set(path, await $.fs.read(path).catch(() => null))),
    ])
  }
}

// What happened to an asked call, from what the model read. A refusal at the
// dialog has no flag of its own: it arrives as the text the model reads.
function outcomeOf(ran: { deny?: string; text?: string; isError?: true }): string {
  const said = ran.deny ?? ran.text ?? ''
  if (/doesn't want to proceed|user (rejected|denied|declined)/i.test(said)) return 'you said no'
  if (/interrupted/i.test(said)) return 'interrupted'
  if (ran.deny !== undefined) return 'not run (refused)'
  if (ran.isError) return 'ran, ended with an error'
  return 'ran'
}

// The transcript shows a banner only while its dialog waits: once the call is
// answered, the outcome written to history redraws the row without it, and the
// pane keeps the record.
const WAITING = 'waiting for you'
const isWaiting = (entry: Entry) => entry.outcome === WAITING
const LOST = 'not recorded: the mod reloaded'

// The pane's flag: how the permission was answered. A call that ran was
// approved (by you, or in auto mode by the classifier). An interrupted one
// can't be told apart: it may have been stopped at the dialog or while running.
// "(auto)" marks what auto mode's classifier decided in your place. Only on
// its own record of deciding (decidedBy): a permission it hands to you, even
// in auto mode, is yours and shows no mark.
type Status = { label: string; mark: string; color?: ThemeKey }
function statusOf(entry: Pick<Entry, 'outcome' | 'decidedBy' | 'decisionSource'>): Status {
  const { outcome } = entry
  const by = deciderFor(entry) === 'classifier' ? ' (auto)' : ''
  if (outcome === WAITING) return { label: 'waiting', mark: '… waiting', color: 'warning' }
  if (outcome === 'ran') return { label: 'approved', mark: `✓ approved${by}`, color: 'success' }
  if (outcome.startsWith('ran')) return { label: 'approved', mark: `✓ approved${by} · ended with an error`, color: 'success' }
  if (outcome === 'interrupted') return { label: 'interrupted', mark: '■ interrupted' }
  if (outcome === LOST) return { label: 'unknown', mark: '? not recorded (the mod reloaded)' }
  if (outcome === 'you said no') return { label: 'denied', mark: '✗ denied', color: 'error' }
  return { label: 'denied', mark: `✗ denied${by}`, color: 'error' }
}

// Who answered a permission: no event says so directly, but Claude Code logs
// its own OpenTelemetry record of each decision, "tool_decision", on the
// collector stream a mod may read (telemetry.log). It carries the call's
// tool_use_id and a source: "user_temporary", "user_permanent", "user_reject",
// "user_abort" when you answered the dialog. Only asked calls are recorded, so
// one settled as "config" never reached the dialog: auto mode's classifier
// decided it (seen in v2.1.296: classifier-approved asks log "config"). "hook"
// is a permission hook, and any other source gets no mark. Only the id and
// source are read; the rest is left alone.
type Decider = NonNullable<Entry['decidedBy']>
function deciderOf(source: string): Decider | null {
  if (/^user_/i.test(source)) return 'you'
  if (/^config$|classifier|auto/i.test(source)) return 'classifier'
  return null
}
// Worked out from the stored source when drawn, so entries recorded before a
// source was understood read right too.
const deciderFor = (entry: Pick<Entry, 'decidedBy' | 'decisionSource'>) =>
  (entry.decisionSource ? deciderOf(entry.decisionSource) : null) ?? entry.decidedBy ?? null

const LEVEL_LABELS: Record<RiskLevel, string> = { safe: '🟢 SAFE', low: '🔵 LOW RISK', attention: '🟡 NEEDS ATTENTION', high: '🔴 HIGH RISK' }
// The banner without its level: what's after "🔴 HIGH RISK — ".
const reasonOf = (banner: string) => banner.split(' — ').slice(1).join(' — ') || banner
// What the risky-only filter keeps: the ones worth a look, and any still open.
const isRisky = (entry: Entry) => entry.level === 'attention' || entry.level === 'high' || isWaiting(entry)

// Paths as they read from the project: its folder is ".", the one above
// "..", the home folder "~". Only for drawing: the record keeps them whole.
type Places = { cwd: string; home: string | undefined }
async function placesOf($: EngineInterface): Promise<Places> {
  return { cwd: await $.session.cwd(), home: (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) }
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function shorten(text: string, { cwd, home }: Places): string {
  const trim = (p: string) => p.replace(/[\\/]+$/, '')
  const here = trim(cwd)
  const parent = here.replace(/[\\/][^\\/]*$/, '')
  const swaps: [string, string][] = [[here, '.']]
  // Not a bare drive or root: "C:" or "" would match too much.
  if (parent !== here && /[\\/]/.test(parent)) swaps.push([parent, '..'])
  if (home) swaps.push([trim(home), '~'])
  swaps.sort((a, b) => b[0].length - a[0].length)
  let out = text
  for (const [path, short] of swaps) {
    if (!path) continue
    // Either slash, and Git Bash's /c/ for C:.
    const drive = /^([A-Za-z]):(.*)$/.exec(path)
    const body = (drive ? drive[2] : path).split(/[\\/]+/).map(escape).join('[\\\\/]+')
    const start = drive ? `(?:${drive[1]}:|/${drive[1]})` : ''
    const at = new RegExp(`(?<![\\w/\\\\.:-])${start}${body}(?=[\\\\/"'\\s),;]|$)`, 'gi')
    out = out.replace(at, short)
  }
  return out
}
// The banners under a transcript row, between thin dim rules, so they stand
// apart from the row above and the permission dialog below.
type Resolved = ReturnType<EngineInterface['ui']['resolve']>
function bannerBlock(Text: Resolved['Text'], entries: Entry[], places: Places, columns: number) {
  const rule = () => Text({ dimColor: true, wrap: 'truncate-end', children: [`  ${'─'.repeat(Math.max(1, Math.min(columns - 4, 100)))}`] })
  return [
    rule(),
    ...entries.map(entry => Text({ bold: true, color: COLORS[entry.level], children: [`  ${shorten(entry.banner, places)}`] })),
    rule(),
  ]
}

// The breakdown's parts, read back from its text (lib/explain.js writes it for
// the dialog), so entries recorded earlier draw the same way.
type Step = { n: string; command: string; what: string; how: string }
type Details = { said?: string; steps: Step[]; more?: string; also?: string; risks: { mark: string; text: string }[]; why?: string }
// How a step joins the one before, as explain.js leads it, said shortly.
const JOINS: [RegExp, (before: number) => string][] = [
  [/^then, if that worked: /, n => `only if ${n} worked`],
  [/^if that failed: /, n => `only if ${n} failed`],
  [/^its output goes to: /, n => `reads ${n}'s output`],
  [/^alongside: /, n => `runs alongside ${n}`],
  [/^then: /, () => ''],
  [/^first, inside \$\(…\): /, () => 'runs first, inside $(…); its output goes into the command'],
]
function parseDetails(text: string): Details {
  const d: Details = { steps: [], risks: [] }
  let section = ''
  for (const line of text.split('\n').slice(1)) {
    const step = /^ {2}(\d+)\. (.*)$/.exec(line)
    const risk = /^ {2}(!!|!|·)\s+(.*)$/.exec(line)
    if (/ is waiting for you\./.test(line)) d.said = /Claude says: "(.*)"$/.exec(line)?.[1]
    else if (line === 'What it does:') section = 'steps'
    else if (line === 'Worth a look:') section = 'risks'
    else if (line.startsWith('Also: ')) d.also = line.slice('Also: '.length)
    else if (line.startsWith('Why it asked: ')) d.why = line.slice('Why it asked: '.length)
    else if (section === 'steps' && step) {
      let rest = step[2] ?? ''
      let how = ''
      const join = JOINS.find(([lead]) => lead.test(rest))
      if (join) {
        rest = rest.replace(join[0], '')
        how = join[1](Number(step[1]) - 1)
      }
      const at = rest.indexOf(' — ')
      d.steps.push({ n: step[1] ?? '', command: at < 0 ? rest : rest.slice(0, at), what: at < 0 ? '' : rest.slice(at + 3), how })
    } else if (section === 'steps' && /^ {2}…and /.test(line)) d.more = line.trim()
    else if (section === 'risks' && risk) d.risks.push({ mark: risk[1] ?? '', text: risk[2] ?? '' })
  }
  return d
}
// "Reads outside … are blocked (…). Add the directory with /add-dir, or …" as
// one sentence a line.
const sentences = (text: string) => text.split(/(?<=[.:])\s+(?=[A-Z"])/).filter(Boolean)

// "cd "." && npm test" reads as "npm test": changing into the project is noise.
const withoutCdHere = (command: string) => command.replace(/^(?:cd|Set-Location|sl)\s+(?:"\."|'\.'|\.)\s*(?:&&|;)\s*/i, '')

const pad = (n: number) => String(n).padStart(2, '0')
const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
const oneLine = (s: string, max = 120) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'shell-explainer',
      description: 'Show every shell command Claude asked permission for this session, explained, with its risk level',
      immediate: true,
    })
    // A reload (this runs again then) drops the hooks waiting on a call's end,
    // and no dialog is open across one, so an entry still waiting won't hear
    // how it ended. Say so rather than wait forever.
    await update($, history, all => all.map(one => (isWaiting(one) ? { ...one, outcome: LOST } : one)))
    return next(e)
  })

  // tool.check settles whether a call may run. Only an "ask" puts it to the
  // person (or, in auto mode, the classifier), so only then is anything shown.
  // Calls the rules allow never reach a dialog and get nothing.
  on('tool.check', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision !== 'ask' || e.tool_use_id === undefined) return verdict
    const id = e.tool_use_id
    const rated = await rate($, e.tool, e.input, verdict.reason)
    if (rated === null) return verdict

    const entry: Entry = {
      id,
      tool: e.tool,
      command: oneLine(String((e.input as { command?: unknown }).command)),
      level: rated.level,
      banner: rated.banner,
      text: rated.text,
      at: clockTime(await $.clock.now()),
      outcome: WAITING,
    }
    const before = await read($, history)
    // Writing history redraws the row and the pane that read it.
    await update($, history, all => [...all.filter(one => one.id !== id), entry].slice(-MAX_ENTRIES))
    await update($, selected, () => null)
    // Opened unasked, so it shows from 144 columns and waits below that.
    if (before.length === 0) void $.ui.open({ id: PANE, title: PANE_TITLE })
    try {
      $.ui.notice(id, shorten(rated.banner, await placesOf($)))
    } catch {
      // No open dialog to take it; the row and the pane have it.
    }
    return verdict
  }).catch(($, e, next) => next(e)) // never in the way of the verdict

  // What happened next: tool.call resolves once the dialog was answered and the
  // command ran, or didn't.
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const ran = await next(e)
    const asked = (await read($, history)).some(one => one.id === e.tool_use_id)
    if (asked) {
      const outcome = outcomeOf(ran)
      await update($, history, all => all.map(one => (one.id === e.tool_use_id ? { ...one, outcome } : one)))
    }
    return ran
  }).catch(($, e, next) => next(e)) // a failure here must not change the call

  // A rated call's own row, where calls are drawn one per row (verbose mode,
  // the ctrl+o transcript): Claude Code's drawing, then the banner under it.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const entry = (await read($, history)).find(one => one.id === e.props.tool_use_id && isWaiting(one))
    if (entry === undefined) return next(e)
    const row = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: [row, ...bannerBlock(Text, [entry], await placesOf($), e.viewport.columns)] })
  })

  // The usual case: the transcript folds a run of shell calls into one group
  // line ("Deleting the empty hello file", "Ran 2 shell commands"), the line
  // right above the permission dialog. The banners of its rated calls go under it.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const all = await read($, history)
    const found = e.props.calls
      .filter(call => SHELLS.includes(call.tool))
      .flatMap(call => all.filter(one => one.id === call.tool_use_id && isWaiting(one)))
    if (found.length === 0) return next(e)
    const group = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: [group, ...bannerBlock(Text, found, await placesOf($), e.viewport.columns)] })
  })

  // Claude Code's own records, read while a permission waits for who decided
  // it, and passed on exactly as they came.
  on('telemetry.log', { to: 'collector', event: 'tool_decision' }, async ($, e, next) => {
    const { tool_use_id: id, source } = e.attributes as { tool_use_id?: unknown; source?: unknown }
    if (typeof id === 'string' && typeof source === 'string') {
      const asked = (await read($, history)).some(one => one.id === id)
      if (asked) {
        const by = deciderOf(source)
        await update($, history, all =>
          all.map(one => (one.id === id ? { ...one, decisionSource: source, ...(by ? { decidedBy: by } : {}) } : one)),
        )
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // never in the way of the record

  on('command.run', { command: 'shell-explainer' }, async $ => {
    await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true })
    return {}
  })

  // The record, newest first, one card each between thin rules. The newest
  // entry shows its breakdown unless the person picked another one (or hid
  // them all). "risky only" hides the green and blue ones already answered.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const entries = await read($, history)
    if (entries.length === 0) {
      return Box({
        flexDirection: 'column',
        children: [Text({ dimColor: true, children: ['No shell command has asked for permission in this session yet.'] })],
      })
    }
    const pick = await read($, selected)
    const open = pick ?? entries[entries.length - 1]?.id ?? ''
    const onlyRisky = await read($, riskyOnly)
    const places = await placesOf($)
    const rule = () => Text({ dimColor: true, wrap: 'truncate-end', children: ['─'.repeat(Math.max(1, e.props.bodyColumns))] })

    const shown = [...entries].reverse().filter(entry => !onlyRisky || isRisky(entry))
    const cards = shown.flatMap(entry => {
      const isOpen = entry.id === open
      const status = statusOf(entry)
      const command = withoutCdHere(shorten(entry.command, places))
      return [
        Box({
          key: `entry-${entry.id}`,
          flexDirection: 'column',
          children: [
            // When, and how it was answered; fixed width, so it never splits.
            Box({
              flexDirection: 'row',
              justifyContent: 'space-between',
              children: [
                Box({
                  flexDirection: 'row',
                  flexShrink: 0,
                  columnGap: 2,
                  children: [
                    Text({ dimColor: true, children: [entry.at] }),
                    Text({ color: status.color, dimColor: status.color === undefined, children: [status.mark] }),
                  ],
                }),
                Button({
                  key: `toggle-${entry.id}`,
                  label: isOpen ? 'hide details' : 'details',
                  plain: true,
                  onPress: () => update($, selected, () => (isOpen ? '' : entry.id)),
                }),
              ],
            }),
            // The level, then the reason, which wraps under itself.
            Box({
              flexDirection: 'row',
              columnGap: 2,
              children: [
                Box({ flexShrink: 0, children: [Text({ bold: true, color: COLORS[entry.level], children: [LEVEL_LABELS[entry.level]] })] }),
                Box({ flexGrow: 1, flexShrink: 1, children: [Text({ children: [shorten(reasonOf(entry.banner), places)] })] }),
              ],
            }),
            Text({ dimColor: true, wrap: 'truncate-end', children: [`${entry.tool === 'PowerShell' ? 'PowerShell: ' : ''}${command}`] }),
            ...(isOpen ? [details(entry)] : []),
          ],
        }),
        rule(),
      ]
    })

    // The breakdown in sections: what Claude said, the steps, the risks, why it
    // asked, who decided. Every label sits in a column of its own, so wrapped
    // text stays under its text, never under the label.
    function details(entry: Entry) {
      const d = parseDetails(shorten(entry.text, places))
      const section = (title: string, children: ReturnType<typeof Text>[]) =>
        Box({
          flexDirection: 'column',
          marginTop: 1,
          children: [Text({ bold: true, children: [title] }), Box({ flexDirection: 'column', paddingLeft: 2, children })],
        })
      // A label column and the text beside it, wrapping under itself.
      const row = (label: ReturnType<typeof Text>, width: number, body: ReturnType<typeof Text>[]) =>
        Box({
          flexDirection: 'row',
          children: [
            Box({ width, flexShrink: 0, children: [label] }),
            Box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, children: body }),
          ],
        })

      const parts: ReturnType<typeof Text>[] = []
      if (d.said) parts.push(Box({ marginTop: 1, children: [Text({ italic: true, children: [`“${d.said}”`] })] }))
      if (d.steps.length) {
        const width = String(d.steps.length).length + 3
        parts.push(
          section('What it does', [
            ...d.steps.map(step =>
              row(Text({ dimColor: true, children: [`${step.n}.`] }), width, [
                Text({ children: [step.command] }),
                ...(step.what ? [Text({ dimColor: true, children: [step.what] })] : []),
                ...(step.how ? [Text({ dimColor: true, italic: true, children: [`↳ ${step.how}`] })] : []),
              ]),
            ),
            ...(d.more ? [Text({ dimColor: true, children: [d.more] })] : []),
          ]),
        )
      }
      if (d.risks.length) {
        parts.push(
          section(
            'Worth a look',
            d.risks.map(risk =>
              row(
                Text({ bold: true, color: risk.mark === '!!' ? 'error' : risk.mark === '!' ? 'warning' : undefined, dimColor: risk.mark === '·', children: [risk.mark] }),
                3,
                [Text({ children: [risk.text] })],
              ),
            ),
          ),
        )
      }
      if (d.also) parts.push(section('Also', [Text({ dimColor: true, children: [d.also] })]))
      if (d.why) parts.push(section('Why it asked', sentences(d.why).map(line => Text({ dimColor: true, children: [line] }))))
      // Claude Code's own word for who decided, as its record gave it.
      if (entry.decisionSource) {
        const decider = deciderFor(entry)
        const who = decider === 'you' ? 'you, at the dialog' : decider === 'classifier' ? "auto mode's classifier" : 'see the source'
        parts.push(section('Decided by', [Text({ children: [`${who} (${entry.decisionSource})`] })]))
      }
      return Box({ flexDirection: 'column', paddingLeft: 2, children: parts })
    }

    // "50 asked · 46 approved · 4 denied", or "showing 4 of 50 · risky only".
    const counts = new Map<string, number>()
    for (const entry of entries) {
      const label = statusOf(entry).label
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    const tally = ['waiting', 'approved', 'denied', 'interrupted', 'unknown'].filter(label => counts.has(label)).map(label => ` · ${counts.get(label)} ${label}`)
    const summary = onlyRisky ? `showing ${shown.length} of ${entries.length} · risky only` : `${entries.length} asked${tally.join('')}`
    return Box({
      flexDirection: 'column',
      children: [
        Box({
          flexDirection: 'row',
          justifyContent: 'space-between',
          children: [
            Text({ dimColor: true, children: [summary] }),
            Button({ key: 'risky-only', label: onlyRisky ? 'show all' : 'risky only', plain: true, onPress: () => update($, riskyOnly, isOn => !isOn) }),
          ],
        }),
        rule(),
        ...(shown.length ? cards : [Text({ dimColor: true, children: ['Nothing risky this session.'] })]),
      ],
    })
  })
}
