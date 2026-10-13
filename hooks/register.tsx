import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { CLUSTERS, freshDisk, percentDone, step } from './disk'

const DISK_TOOLS = ['Read', 'Write', 'Edit', 'NotebookEdit', 'Bash']
const SEEK_GAP_MS = 250
const GAIN = 0.6
// The loop's period, and where in spinup.wav it takes over, as the clips were cut.
// Each clip runs 1.5s past those points, fading out under the next one's fade-in, because
// afplay takes up to ~750ms to get going.
const LOOP_PERIOD_MS = 27500
const LOOP_AFTER_SPINUP_MS = 8500
const HANDOVER_MS = 700
const SPINDOWN_MS = 7000
const TICK_MS = 120
// Most quick answers finish inside this, so they never wake the drive.
const SPINUP_DELAY_MS = 4000
const PANE = 'defrag'

const isMuted = atom({ plugin: 'c-drive', key: 'isMuted' } as const, false)
const isSpinning = atom({ plugin: 'c-drive', key: 'isSpinning' } as const, false)
const disk = atom({ plugin: 'c-drive', key: 'disk' } as const, null)
const spinDownAt = atom({ plugin: 'c-drive', key: 'spinDownAt' } as const, null)

const COLORS: Record<string, string> = {
  b: '#3050e0',
  c: '#00b0b0',
  g: '#20c020',
  r: '#e02020',
  w: '#d8d8d8',
}
const LEGEND: [string, string][] = [
  ['b', 'Optimized'],
  ['c', 'Fragmented'],
  ['g', 'Reading'],
  ['r', 'Writing'],
  ['w', 'Free'],
]
const CELL = '▇ '

let sound: AbortController | undefined
let nextLoop: Timer | undefined
let spinningDown: AbortController | undefined
let ticker: Timer | undefined
let spinupTimer: Timer | undefined
let isTurnActive = false
// Set before any await, so a tool call and the timer racing cannot both spin up.
let isSpunUp = false
let lastSeekAt = 0

const playLoop = ($: EngineInterface, stop: AbortController) => {
  if (stop.signal.aborted) return
  $.audio.play({ asset: 'sounds/working.wav' }, { gain: GAIN, signal: stop.signal }).catch(() => {})
  nextLoop = $.clock.after(LOOP_PERIOD_MS, () => playLoop($, stop))
}

const startSound = ($: EngineInterface) => {
  spinningDown?.abort()
  const stop = new AbortController()
  sound = stop
  $.audio.play({ asset: 'sounds/spinup.wav' }, { gain: GAIN, signal: stop.signal }).catch(() => {})
  nextLoop = $.clock.after(LOOP_AFTER_SPINUP_MS, () => playLoop($, stop))
}

const stopSound = ($: EngineInterface, handoverMs: number) => {
  const stopping = sound
  nextLoop?.cancel()
  nextLoop = undefined
  sound = undefined
  if (handoverMs > 0) $.clock.after(handoverMs, () => stopping?.abort())
  else stopping?.abort()
}

const toggleMute = async ($: EngineInterface) => {
  const muted = !(await read($, isMuted))
  await update($, isMuted, () => muted)
  if (muted) {
    stopSound($, 0)
    spinningDown?.abort()
  } else if (isSpunUp) {
    startSound($)
  }
  // Remembered for the next session; failing to remember it should not undo the toggle.
  await $.store.set('isMuted', muted).catch(() => {})
  return muted
}

// The defrag only advances while the drive is spun up, so the map moves with the noise.
const spinUp = async ($: EngineInterface) => {
  spinupTimer?.cancel()
  spinupTimer = undefined
  if (!isTurnActive || isSpunUp) return
  isSpunUp = true
  await update($, isSpinning, () => true)
  if (!(await read($, isMuted))) startSound($)
  ticker = $.clock.every(TICK_MS, () => {
    void update($, disk, current => step(current ?? freshDisk()))
  })
}

const spinDown = async ($: EngineInterface) => {
  spinupTimer?.cancel()
  spinupTimer = undefined
  if (!isSpunUp) return
  isSpunUp = false
  ticker?.cancel()
  ticker = undefined
  await update($, isSpinning, () => false)
  if (sound !== undefined) {
    stopSound($, HANDOVER_MS)
    playSpinDown($)
    const now = await $.clock.now()
    await update($, spinDownAt, () => now)
  }
}

const playSpinDown = ($: EngineInterface) => {
  spinningDown = new AbortController()
  $.audio.play({ asset: 'sounds/spindown.wav' }, { gain: GAIN, signal: spinningDown.signal }).catch(() => {})
}

const openDefrag = async ($: EngineInterface) => {
  await update($, disk, current => current ?? freshDisk())
  return $.ui.open({ id: PANE, title: 'Disk Defragmenter', rows: 16 })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('isMuted')
    await update($, isMuted, () => stored === true)
    // A hot reload stops the old module's audio and timers but keeps state. The edit that
    // causes one ends a turn, so the reload lands just after the spin-down began: play it again.
    const wasSpinning = await read($, isSpinning)
    const spunDownAt = await read($, spinDownAt)
    const now = await $.clock.now()
    await update($, isSpinning, () => false)
    await update($, spinDownAt, () => null)
    if (stored !== true && (wasSpinning || (spunDownAt !== null && now - spunDownAt < SPINDOWN_MS))) playSpinDown($)
    await $.command.register({ name: 'hdd', description: 'Turn the hard disk sound on or off' })
    await $.command.register({ name: 'defrag', description: 'Open the disk defragmenter window' })
    return next(e)
  })

  on('command.run', { command: 'hdd' }, async $ => ({
    text: (await toggleMute($)) ? 'Hard disk sound off.' : 'Hard disk sound on.',
  }))

  on('command.run', { command: 'defrag' }, async $ => {
    const opened = await openDefrag($)
    return { text: opened.isPlaced ? 'Defragmenting drive C.' : 'The defrag window will show once the terminal is wider.' }
  })

  on('turn.start', async ($, e, next) => {
    if (!isTurnActive) {
      isTurnActive = true
      spinupTimer = $.clock.after(SPINUP_DELAY_MS, () => void spinUp($))
    }
    return next(e)
  })

  // Subagent turns end here too, while the main turn is still running.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && isTurnActive) {
      isTurnActive = false
      await spinDown($)
    }
    return next(e)
  })

  // Disk work wakes the drive at once. Rapid parallel reads would stack into noise, so seeks are spaced out.
  on('tool.call', async ($, e, next) => {
    if (DISK_TOOLS.includes(e.tool)) {
      await spinUp($)
      const now = await $.clock.now()
      if (!(await read($, isMuted)) && now - lastSeekAt >= SEEK_GAP_MS) {
        lastSeekAt = now
        $.audio.play({ asset: 'sounds/seek.wav' }, { gain: 0.5 }).catch(() => {})
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isSpinning))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const muted = await read($, isMuted)
    return (
      <Box>
        <Text color={COLORS.c}>▤ </Text>
        <Text dimColor={muted}>{muted ? 'Hard disk muted  ' : 'Hard disk grinding…  '}</Text>
        <Button key="sound" hotkey="m" label={muted ? 'Unmute' : 'Mute'} onPress={() => void toggleMute($)} />
        <Text> </Text>
        <Button key="defrag" hotkey="d" label="Defrag" onPress={() => void openDefrag($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const current = (await read($, disk)) ?? freshDisk()
    const spinning = await read($, isSpinning)
    const perRow = Math.max(8, Math.floor(e.props.bodyColumns / CELL.length))
    const percent = percentDone(current)
    const barWidth = Math.max(10, Math.min(40, e.props.bodyColumns - 16))
    const filled = Math.round((barWidth * percent) / 100)

    const rows = []
    for (let start = 0; start < CLUSTERS; start += perRow) {
      const runs = []
      const row = current.cells.slice(start, start + perRow)
      for (let at = 0; at < row.length; ) {
        let end = at
        while (end < row.length && row[end] === row[at]) end += 1
        runs.push(
          <Text key={String(at)} color={COLORS[row[at] ?? 'w']}>
            {CELL.repeat(end - at)}
          </Text>,
        )
        at = end
      }
      rows.push(<Text key={String(start)}>{runs}</Text>)
    }

    const status =
      current.phase === 'restarting' ? 'Drive contents have changed. Restarting…' : spinning ? `${percent}% Complete` : `${percent}% Complete · paused`

    return (
      <Box flexDirection="column">
        <Text bold>Defragmenting Drive C</Text>
        {rows}
        <Text>
          <Text color={COLORS.b}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(barWidth - filled)}</Text> {status}
        </Text>
        <Text>
          {LEGEND.map(([cell, label]) => (
            <Text key={cell}>
              <Text color={COLORS[cell]}>▇</Text> {label}{'  '}
            </Text>
          ))}
        </Text>
      </Box>
    )
  })
}
