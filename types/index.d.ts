// The values shell-explainer keeps in $.state.

export type Level = 'safe' | 'low' | 'attention' | 'high'

/** One permission asked for a shell command, as the pane lists it. */
export type Entry = {
  /** The call's tool_use_id. */
  id: string
  tool: string
  /** The command, cut to one short line. */
  command: string
  level: Level
  /** The one-line rating, also drawn under the command's line in the transcript. */
  banner: string
  /** The whole breakdown, banner first. */
  text: string
  /** When it was asked, HH:MM:SS. */
  at: string
  /** "waiting for you", "ran", "you said no", ... */
  outcome: string
  /** Who answered, from Claude Code's own record of it: you at the dialog, or auto mode's classifier. */
  decidedBy?: 'you' | 'classifier'
  /** That record's own word for who decided ("user_temporary", "config", ...), shown in the breakdown. */
  decisionSource?: string
}

declare module 'claude-code' {
  interface PluginState {
    'shell-explainer': {
      /** Every permission asked this session, oldest first, the newest 100. */
      history: Entry[]
      /** The entry whose breakdown the pane shows: null for the newest, '' for none. */
      selected: string | null
      /** The pane shows only the entries worth a look (🟡, 🔴, still waiting). */
      riskyOnly: boolean
    }
  }
}
