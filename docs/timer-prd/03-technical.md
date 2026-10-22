# 03 - Technical Specification

## 3.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                       timer.html                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Frontend (HTML/CSS/JS)                 │   │
│  │  - Timer logic (countdown, level progression)            │   │
│  │  - UI rendering (blinds, leaderboard, bounty)           │   │
│  │  - Event handlers (play, pause, next round)             │   │
│  └──────────────────────────────────────────────────────────┘   │
│              │                              │                    │
│              ▼                              ▼                    │
│  ┌──────────────────────┐    ┌──────────────────────────────┐   │
│  │  firebase-api.js     │    │  GAS Webhook                 │   │
│  │  (PokerAPI wrapper)  │    │  (Google Apps Script)        │   │
│  └──────────────────────┘    └──────────────────────────────┘   │
│              │                              │                    │
└──────────────┼──────────────────────────────┼────────────────────┘
               │                              │
               ▼                              ▼
       ┌───────────────┐            ┌──────────────────┐
       │   Firestore   │            │  Google Sheets   │
       │  - checkins   │            │  - Hand of Night │
       │  - eliminations│           │  - Schedule      │
       │  - bounties   │            │                  │
       │  - players    │            │                  │
       └───────────────┘            └──────────────────┘
```

## 3.2 File Structure

```
All-In-Poker-App/
├── timer.html              # Main timer application (NEW)
├── public/
│   └── firebase-api.js     # Existing Firebase wrapper (REUSE)
├── functions/
│   └── index.js            # Cloud Functions (NO CHANGES)
├── docs/
│   └── timer-prd/          # This PRD folder (NEW)
└── ../backend.gs           # GAS backend (ADD getHandOfNight)
```

## 3.3 Data Flow

### 3.3.1 Leaderboard Data
```
1. timer.html calls PokerAPI.getLeaderboard({ venue: 'tight' })
2. firebase-api.js makes httpsCallable to Cloud Function
3. Cloud Function queries Firestore collections
4. Returns { standings: [...], championshipDate: '...' }
5. timer.html renders leaderboard and bounty list
6. Repeat every 60 seconds
```

### 3.3.2 Hand of Night Data
```
1. timer.html fetches GAS_WEBHOOK_URL + '?action=getHandOfNight&venue=tight'
2. GAS reads from configured cell in Google Sheets
3. Returns { hand: 'A K', bonus: 500, suits: '/s/d' }
4. timer.html renders in header corners
5. Refresh on page load only (manual refresh available)
```

### 3.3.3 Timer State (Local Only)
```
- Timer state stored in JavaScript variables
- No server persistence for MVP
- Page refresh resets timer
- Future: Could sync via Firebase Realtime Database
```

## 3.4 Firebase Configuration

### 3.4.1 Existing Config (Reuse)
```javascript
const firebaseConfig = {
  apiKey: "demo-api-key",
  authDomain: "demo-poker.firebaseapp.com",
  projectId: "demo-poker",
  storageBucket: "demo-poker.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:0000demo0000"
};
```

### 3.4.2 SDK Version
- Firebase SDK 10.7.1 (via CDN, same as leaderboard.html)

### 3.4.3 API Usage
```javascript
// Leaderboard (existing)
const result = await PokerAPI.getLeaderboard({ venue: currentVenue });
// Returns: { status, standings[], championshipDate }

// Each standing entry:
{
  name: "Player Name",
  points: 150,
  bounties: 2,
  gamesPlayed: 5,
  wins: 1,
  qualified: true/false,
  rank: 1
}
```

## 3.5 GAS Webhook

### 3.5.1 Existing Endpoint
```
https://script.google.com/macros/s/AKfycbzNQWweCvt4LN0k9-XsCUkkjYlYc-1zU2YgrP4_DQZxh2S7A7EiZo9c26T0r2PAKQsA/exec
```

### 3.5.2 New Action Required
**Action**: `getHandOfNight`
**Parameters**: `venue` (tight|corgi)
**Response**:
```javascript
{
  success: true,
  hand: "A K",
  bonus: 500,
  suits: "/s/d",  // Optional: suit notation
  display: "A♠ K♦ | 500"  // Pre-formatted for display
}
```

### 3.5.3 Google Sheets Location
- Sheet: "All-In Poker Rankings"
- Tab: Create new "Timer Settings" tab or use existing config area
- Cells: HandOfNight_TightEnd, HandOfNight_Corgi, Bonus_TightEnd, Bonus_Corgi

## 3.6 Timer Logic

### 3.6.1 Core Timer Object
```javascript
const Timer = {
  games: {
    0: { // Game 1
      currentLevel: 0,
      timeRemaining: 300, // seconds
      isRunning: false,
      isPaused: true
    },
    1: { // Game 2
      currentLevel: 0,
      timeRemaining: 300,
      isRunning: false,
      isPaused: true
    }
  },

  start(gameId) { /* Start/resume timer */ },
  pause(gameId) { /* Pause timer */ },
  addMinute(gameId) { /* Add 60 seconds */ },
  subtractMinute(gameId) { /* Remove 60 seconds (min 0) */ },
  nextRound(gameId) { /* Advance to next level */ },
  reset(gameId) { /* Reset current level time */ },
  tick() { /* Called every second, updates display */ }
};
```

### 3.6.2 Update Loop
```javascript
setInterval(() => {
  Timer.tick();
  updateDisplay();
}, 1000);
```

### 3.6.3 Level Progression
```javascript
function nextRound(gameId) {
  const game = Timer.games[gameId];
  game.currentLevel++;

  const level = BLIND_LEVELS[game.currentLevel];
  game.timeRemaining = level.duration * 60;

  if (level.isBreak) {
    // Optionally play break sound
  }

  updateDisplay();
}
```

## 3.7 Dependencies

### 3.7.1 External Libraries
| Library | Version | Purpose |
|---------|---------|---------|
| Firebase SDK | 10.7.1 | Firestore, Cloud Functions |
| jQuery | 3.6.0 | DOM manipulation (optional) |

### 3.7.2 Internal Dependencies
| File | Purpose |
|------|---------|
| firebase-api.js | PokerAPI wrapper for Cloud Functions |

## 3.8 Browser Compatibility

### 3.8.1 Target Browsers
- Chrome (primary - used on venue TVs)
- Edge (Windows Surface)
- Firefox (backup)

### 3.8.2 Required Features
- ES6+ JavaScript (let, const, arrow functions, async/await)
- CSS Grid and Flexbox
- Fetch API
- setInterval/setTimeout
