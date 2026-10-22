// Blind structures for the shared clock. Any controller (the TV page or a
// staff phone) publishes the structure into timerClocks/{id} when it starts a
// clock, so no particular device is needed. Moved out of staff/timer.html
// (BLIND_LEVELS) on 2026-10-15. Pure data, no imports.
//
// Level fields: level (number, or 'B1'.. for breaks), name, duration (minutes),
// small, big, isBreak, isPreGame, chipUp (break text), displayChips (late
// levels shown in 5K chips), display (TV hint text).

export const STRUCTURES = {
  standard: {
    id: 'standard',
    name: 'Standard (league night)',
    levels: [
      { level: 0, name: "Draw for Seats", duration: 5, small: 0, big: 0, isBreak: false, isPreGame: true, display: "Next: Announcements" },
      { level: 0, name: "Announcements",  duration: 5, small: 0, big: 0, isBreak: false, isPreGame: true, display: "Next: 25 / 50" },
      { level: 1, name: "Round 1", duration: 12, small: 25, big: 50, isBreak: false },
      { level: 2, name: "Round 2", duration: 12, small: 50, big: 100, isBreak: false },
      { level: 'B1', name: "Break", duration: 8, small: 0, big: 0, isBreak: true },
      { level: 3, name: "Round 3", duration: 12, small: 100, big: 200, isBreak: false },
      { level: 4, name: "Round 4", duration: 12, small: 200, big: 400, isBreak: false },
      { level: 'B2', name: "Break & Chip Up", duration: 10, small: 0, big: 0, isBreak: true, chipUp: "Red, White & Blue into stacks of 500" },
      { level: 5, name: "Round 5", duration: 12, small: 500, big: 1000, isBreak: false },
      { level: 6, name: "Round 6", duration: 12, small: 1000, big: 2000, isBreak: false },
      { level: 7, name: "Round 7", duration: 12, small: 2000, big: 4000, isBreak: false },
      { level: 'B3', name: "Quick Chip-up", duration: 3, small: 0, big: 0, isBreak: true, chipUp: "Convert to 5K chips" },
      { level: 8, name: "Round 8", duration: 12, small: 5000, big: 10000, isBreak: false, displayChips: "1/2" },
      { level: 9, name: "Round 9", duration: 12, small: 10000, big: 20000, isBreak: false, displayChips: "2/4" },
      { level: 10, name: "Round 10", duration: 12, small: 20000, big: 40000, isBreak: false, displayChips: "4/8" },
      { level: 11, name: "Round 11", duration: 12, small: 40000, big: 80000, isBreak: false, displayChips: "8/16" },
      { level: 12, name: "Round 12", duration: 12, small: 80000, big: 160000, isBreak: false, displayChips: "16/32" },
      { level: 13, name: "Round 13", duration: 12, small: 160000, big: 320000, isBreak: false, displayChips: "32/64" },
    ]
  }
};

export const DEFAULT_STRUCTURE_ID = 'standard';
