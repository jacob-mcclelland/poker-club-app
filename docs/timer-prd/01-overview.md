# 01 - Project Overview

## 1.1 Project Summary

Build a new poker tournament timer (`timer.html`) for the All-In Poker Club that replaces/supplements the existing Timer.x2 system hosted on evere1.com. The new timer will integrate with the existing Firebase infrastructure and provide auto-updating displays for tournament management.

## 1.2 Goals

### Primary Goals
1. **Auto-updating data** - Leaderboard standings, bounty counts, and Hand of Night update automatically without manual intervention
2. **Firebase integration** - Leverage existing Firestore collections and Cloud Functions
3. **Multi-venue support** - Switch between Tight End and Wild Corgi with appropriate branding
4. **Familiar interface** - Match the existing rainbow/neon aesthetic players are used to

### Secondary Goals
1. **Portability** - Works on TV/projector and Windows Surface tablet
2. **Maintainability** - Code hosted in existing Firebase project, easy to update
3. **Future extensibility** - Structure allows for remote timer control in future

## 1.3 Scope

### In Scope (MVP)
- [ ] Blind timer with full level structure (13+ rounds)
- [ ] Auto-updating leaderboard display from Firebase
- [ ] Auto-updating bounty list from Firebase
- [ ] Hand of Night display from Google Sheets
- [ ] Multi-venue support (Tight End / Wild Corgi)
- [ ] Two-game layout (Game 1 large, Game 2 hidden until activated)
- [ ] Timer controls (Play/Pause, +Min/-Min, Next Round, Reset)
- [ ] Rainbow gradient visual style matching existing timer
- [ ] Venue logo integration

### Out of Scope (Future)
- Remote timer control from mobile devices
- Real-time timer sync across multiple displays
- Configurable blind structures
- Holiday-themed timer variants
- Seat selection card draw animation
- Player check-in integration with timer

## 1.4 Target Users

| User | Usage |
|------|-------|
| **Tournament Directors** | Control timer, manage game flow |
| **Players** | View blind levels, leaderboard standings |
| **Venue Staff** | Display on TV/projector |

## 1.5 Success Metrics

1. Timer displays correctly on venue TV/projector
2. Leaderboard data matches Firebase within 60 seconds of changes
3. Bounty data matches Firebase within 60 seconds of changes
4. Hand of Night displays correctly from Google Sheets
5. Venue switching works correctly for both locations
6. Game 2 activation works without page reload
