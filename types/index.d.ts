/**
 * The defrag map: one character per cluster. `b` optimized, `c` fragmented,
 * `w` free, `g` being read, `r` being written.
 */
export type Disk = {
  cells: string
  // Every cluster before this one is optimized.
  frontier: number
  phase: 'seek' | 'verify' | 'move' | 'write' | 'restarting'
  // The cluster being read, while verifying or moving.
  from: number
  // The percentage at which the drive contents "change" and the defrag starts over.
  giveUpAt: number
  // Ticks spent showing the restart message before a new disk is drawn.
  restartTicks: number
}

declare module 'claude-code' {
  interface PluginState {
    'c-drive': { isMuted: boolean; isSpinning: boolean; spinDownAt: number | null; disk: Disk | null }
  }
}
