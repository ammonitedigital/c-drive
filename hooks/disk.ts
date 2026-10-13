import type { Disk } from '../types'

export const CLUSTERS = 480
const RESTART_TICKS = 25
const LOOKAHEAD = 3

export const freshDisk = (random = Math.random): Disk => {
  // No optimized head start, so every pass begins at 0%.
  let cells = ''
  while (cells.length < CLUSTERS) {
    cells += (random() < 0.55 ? 'c' : 'w').repeat(1 + Math.floor(random() * 6))
  }
  cells = cells.slice(0, CLUSTERS)
  const giveUpAt = 88 + Math.floor(random() * 12)
  return { cells, frontier: 0, phase: 'seek', from: -1, giveUpAt, restartTicks: 0 }
}

const put = (cells: string, at: number, cell: string) => cells.slice(0, at) + cell + cells.slice(at + 1)

// One tick of a 90s defrag: walk the frontier forward, verifying clusters already in place
// and pulling the next few fragmented ones down into each free gap. Like the real thing, it
// never finishes: just short of the end the drive contents change and it starts over.
export const step = (disk: Disk, random = Math.random): Disk => {
  const { cells, from } = disk
  switch (disk.phase) {
    case 'restarting':
      return disk.restartTicks >= RESTART_TICKS ? freshDisk(random) : { ...disk, restartTicks: disk.restartTicks + 1 }
    case 'verify':
      return { ...disk, cells: put(cells, from, 'b'), frontier: from + 1, phase: 'seek' }
    case 'move':
      return { ...disk, cells: put(put(cells, from, 'w'), disk.frontier, 'r'), phase: 'write' }
    case 'write':
      return { ...disk, cells: put(cells, disk.frontier, 'b'), frontier: disk.frontier + 1, phase: 'seek' }
    case 'seek': {
      let frontier = disk.frontier
      while (frontier < CLUSTERS && cells[frontier] === 'b') frontier += 1
      if (cells.indexOf('c', frontier) === -1 || percentDone({ ...disk, frontier }) >= disk.giveUpAt) {
        return { ...disk, frontier, phase: 'restarting', restartTicks: 0 }
      }
      if (cells[frontier] === 'c') {
        return { ...disk, cells: put(cells, frontier, 'g'), frontier, phase: 'verify', from: frontier }
      }
      const candidates: number[] = []
      for (let at = frontier; at < CLUSTERS && candidates.length < LOOKAHEAD; at += 1) {
        if (cells[at] === 'c') candidates.push(at)
      }
      const pick = candidates[Math.floor(random() * candidates.length)] ?? frontier
      return { ...disk, cells: put(cells, pick, 'g'), frontier, phase: 'move', from: pick }
    }
    // A disk saved by an older version of the mod.
    default:
      return freshDisk(random)
  }
}

// Everything before the frontier is optimized, so this is how far the frontier is through the data.
export const percentDone = (disk: Disk) => {
  const data = disk.cells.replace(/w/g, '').length
  return data === 0 ? 100 : Math.min(100, Math.floor((100 * disk.frontier) / data))
}
