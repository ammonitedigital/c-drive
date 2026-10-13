import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { CLUSTERS, freshDisk, percentDone, step } from '../hooks/disk'

const DONE = { answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as const
const SCROLL = { offset: 0, bodyRows: 20 }

const world = (on: On, now = 0) => {
  const clock = mock.clock(on, { now })
  mock.store(on)
  const played: string[] = []
  on('audio.play', (_, e) => {
    if (e.clip.asset !== undefined) played.push(e.clip.asset.replace(/^sounds\/|\.wav$/g, ''))
    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }))
  return { clock, played }
}

const BAND = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80, scroll: SCROLL, view: {} }
const PANE = { title: 'Disk Defragmenter', isFocused: false, bodyColumns: 100, placement: 'inline', scroll: SCROLL, view: {} } as const

describe('sound', () => {
  test('a quick answer never wakes the drive', async ($, on) => {
    const { clock, played } = world(on)

    await $.turn.start({ text: 'hi', turnId: 't1' })
    await clock.advance(3000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.advance(30000)
    expect(played).toEqual([])
  })

  test('a long turn spins up after the delay, loops back to back, then spins down', async ($, on) => {
    const { clock, played } = world(on)

    await $.turn.start({ text: 'hi', turnId: 't1' })
    await clock.advance(3999)
    expect(played).toEqual([])
    await clock.advance(1)
    expect(played).toEqual(['spinup'])

    await clock.advance(8500)
    expect(played).toEqual(['spinup', 'working'])

    await $.turn.complete({ ...DONE, turnId: 's1', agentId: 'sub' })
    await $.turn.start({ text: '', turnId: 't1b' })
    await clock.advance(27500)
    expect(played).toEqual(['spinup', 'working', 'working'])

    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.advance(60000)
    expect(played).toEqual(['spinup', 'working', 'working', 'spindown'])
  })

  test('disk work spins up at once, only once, and a turn ending during spin-up never starts the loop', async ($, on) => {
    const { clock, played } = world(on, 1000)

    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/tmp/a' })
    expect(played).toEqual(['spinup', 'seek'])

    await clock.advance(3000)
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.advance(30000)
    expect(played).toEqual(['spinup', 'seek', 'seek', 'spindown'])
  })

  test('a reload that cuts off a spinning drive still spins it down', async ($, on) => {
    const { clock, played } = world(on)
    on('session.start', (_, e) => ({ cwd: e.cwd }))

    await $.turn.start({ text: 'hi', turnId: 't1' })
    await clock.advance(4000)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    expect(played).toEqual(['spinup', 'spindown'])

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    expect(played).toEqual(['spinup', 'spindown'])
  })

  test('a reload just after a spin-down began plays it again, but not a stale one', async ($, on) => {
    const { clock, played } = world(on)
    on('session.start', (_, e) => ({ cwd: e.cwd }))

    await $.turn.start({ text: 'hi', turnId: 't1' })
    await clock.advance(4000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.advance(30)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    expect(played).toEqual(['spinup', 'spindown', 'spindown'])

    await $.turn.start({ text: 'hi', turnId: 't2' })
    await clock.advance(4000)
    await $.turn.complete({ ...DONE, turnId: 't2' })
    await clock.advance(10000)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    expect(played).toEqual(['spinup', 'spindown', 'spindown', 'spinup', 'spindown'])
  })

  test('disk tools seek, spaced out; other tools stay quiet', async ($, on) => {
    const { clock, played } = world(on, 1000)

    await $.tool.call({ tool: 'Read', file_path: '/tmp/a' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.tool.call({ tool: 'WebSearch', query: 'x', mode: 'standard' })
    await clock.advance(300)
    await $.tool.call({ tool: 'Edit', file_path: '/tmp/a', old_string: 'a', new_string: 'b' })
    expect(played).toEqual(['seek', 'seek'])
  })
})

describe('band', () => {
  test('stays away until the drive spins up, and goes when it spins down', async ($, on) => {
    const { clock } = world(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
    const band = await $.ui.mount({ plugin: 'c-drive', surface: 'terminal', component: 'AbovePrompt', props: BAND })

    await $.turn.start({ text: 'hi', turnId: 't1' })
    expect(await band.find({ key: 'sound' })).toBeUndefined()

    await clock.advance(4000)
    expect(await band.find({ key: 'sound', text: 'Mute' })).toBeDefined()

    await $.turn.complete({ ...DONE, turnId: 't1' })
    expect(await band.find({ key: 'sound' })).toBeUndefined()
  })

  test('mutes mid-turn, stays quiet, and unmuting spins back up', async ($, on) => {
    const { clock, played } = world(on, 1000)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await clock.advance(4000)

    const band = await $.ui.mount({ plugin: 'c-drive', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    await band.press({ key: 'sound' })
    expect(await band.find({ key: 'sound', text: 'Unmute' })).toBeDefined()

    await clock.advance(40000)
    await $.tool.call({ tool: 'Read', file_path: '/tmp/a' })
    expect(played).toEqual(['spinup'])

    await band.press({ key: 'sound' })
    expect(played).toEqual(['spinup', 'spinup'])
  })
})

describe('defrag', () => {
  test('every disk gets nearly done, then restarts with a new one', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      let state = seed
      const random = () => ((state = (state * 16807) % 2147483647) - 1) / 2147483646
      let d = freshDisk(random)
      expect(percentDone(d)).toBe(0)
      const data = d.cells.replace(/w/g, '').length
      let ticks = 0
      while (d.phase !== 'restarting' && ticks < 10000) {
        d = step(d, random)
        ticks += 1
      }
      expect(d.phase).toBe('restarting')
      expect(d.cells.slice(0, d.frontier)).toBe('b'.repeat(d.frontier))
      expect(d.cells.length).toBe(CLUSTERS)
      expect(d.cells.replace(/w/g, '').length).toBe(data)
      expect(percentDone(d)).toBeGreaterThanOrEqual(88)
      expect(percentDone(d)).toBeLessThan(100)
      for (let i = 0; i <= 25; i += 1) d = step(d, random)
      expect(d.phase).toBe('seek')
    }
  })

  test('the pane draws the map, the progress and the legend', async $ => {
    const pane = await $.ui.mount({
      plugin: 'c-drive',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'defrag',
      props: PANE,
    })
    expect(await pane.find({ type: 'Text', text: 'Defragmenting Drive C' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /% Complete/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Fragmented/ })).toBeDefined()
  })

  test('the map only moves while the drive is spun up', async ($, on) => {
    const { clock } = world(on)
    const pane = await $.ui.mount({ plugin: 'c-drive', surface: 'terminal', component: 'Pane', requestId: 'defrag', props: PANE })
    const map = async () => JSON.stringify(await pane.drawn())
    const before = await map()

    await $.turn.start({ text: 'hi', turnId: 't1' })
    await clock.advance(3000)
    expect(await map()).toBe(before)
    expect(await pane.find({ type: 'Text', text: /paused/ })).toBeDefined()

    await clock.advance(2000)
    expect(await map()).not.toBe(before)
    expect(await pane.find({ type: 'Text', text: /paused/ })).toBeUndefined()

    await $.turn.complete({ ...DONE, turnId: 't1' })
    const stopped = await map()
    await clock.advance(5000)
    expect(await map()).toBe(stopped)
  })
})
