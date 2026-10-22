# 05 - Task Breakdown

## Phase 1: Project Setup

### Task 1.1: Create Base HTML Structure
**Estimate**: Foundation
**File**: `timer.html`

- [ ] **1.1.1** Create timer.html file with DOCTYPE and head section
- [ ] **1.1.2** Add Firebase SDK script tags (copy from leaderboard.html)
- [ ] **1.1.3** Add firebase-api.js script reference
- [ ] **1.1.4** Set up basic HTML structure with semantic sections
  - Header container
  - Menu container
  - Game container (game 1 + game 2 areas)
  - Lower container (leaderboard, bounty, seat map)
  - Footer container
- [ ] **1.1.5** Add meta viewport tag for responsive behavior
- [ ] **1.1.6** Add page title with venue name support

### Task 1.2: Set Up CSS Foundation
**Estimate**: Styling base
**File**: `timer.html` (inline) or `css/timer.css`

- [ ] **1.2.1** Define CSS variables for colors
  ```css
  :root {
    --bg-dark: #1a1a1a;
    --timer-green: #ccff00;
    --blind-red: #ff0000;
    --blind-yellow: #ffff00;
    --next-blue: #00aaff;
    --break-magenta: #ff00ff;
  }
  ```
- [ ] **1.2.2** Create rainbow gradient classes for header/footer
- [ ] **1.2.3** Set up CSS Grid for page layout
- [ ] **1.2.4** Add flexbox utilities for component alignment
- [ ] **1.2.5** Create responsive breakpoint media queries
- [ ] **1.2.6** Add font-face declarations if using custom fonts

---

## Phase 2: Timer Core Implementation

### Task 2.1: Define Blind Structure Data
**File**: `timer.html` (JavaScript)

- [ ] **2.1.1** Create BLIND_LEVELS constant array with all 13+ levels
- [ ] **2.1.2** Include level properties: level, name, duration, small, big, isBreak, chipUp, displayChips
- [ ] **2.1.3** Add helper function to get formatted blind display
  ```javascript
  function formatBlinds(level) {
    if (level.displayChips) return level.displayChips;
    if (level.isBreak) return level.name;
    return `${level.small}/${level.big}`;
  }
  ```
- [ ] **2.1.4** Add function to get next level blinds display

### Task 2.2: Implement Timer State Object
**File**: `timer.html` (JavaScript)

- [ ] **2.2.1** Create Timer object with games array (game 0 and game 1)
- [ ] **2.2.2** Add state properties: currentLevel, timeRemaining, isRunning, isPaused
- [ ] **2.2.3** Implement `Timer.start(gameId)` - start/resume countdown
- [ ] **2.2.4** Implement `Timer.pause(gameId)` - pause countdown
- [ ] **2.2.5** Implement `Timer.addMinute(gameId)` - add 60 seconds
- [ ] **2.2.6** Implement `Timer.subtractMinute(gameId)` - remove 60 seconds (min 0)
- [ ] **2.2.7** Implement `Timer.nextRound(gameId)` - advance to next level
- [ ] **2.2.8** Implement `Timer.reset(gameId)` - reset current level to full time
- [ ] **2.2.9** Implement `Timer.tick()` - decrement time, check for level complete

### Task 2.3: Create Timer Update Loop
**File**: `timer.html` (JavaScript)

- [ ] **2.3.1** Set up setInterval for 1-second ticks
- [ ] **2.3.2** Call Timer.tick() and updateDisplay() each second
- [ ] **2.3.3** Handle level completion (auto-advance or pause)
- [ ] **2.3.4** Add sound/visual alert on level change (optional)
- [ ] **2.3.5** Add warning state for last 60 seconds

### Task 2.4: Build Timer Display Components
**File**: `timer.html` (HTML + CSS + JS)

- [ ] **2.4.1** Create game container HTML structure
  ```html
  <div id="game_0" class="game-container">
    <div class="game-header">Game 1 <span id="roundnumber_0">R1</span></div>
    <div id="time_0" class="timer-display">12:00</div>
    <div class="blinds-section">...</div>
    <div class="controls">...</div>
  </div>
  ```
- [ ] **2.4.2** Style timer countdown (large, prominent)
- [ ] **2.4.3** Style round number display
- [ ] **2.4.4** Style "Blinds Now" section
- [ ] **2.4.5** Style "Next Blinds" section
- [ ] **2.4.6** Add special styling for break levels
- [ ] **2.4.7** Create updateTimerDisplay(gameId) function
- [ ] **2.4.8** Create updateBlindsDisplay(gameId) function

### Task 2.5: Implement Timer Controls
**File**: `timer.html` (HTML + JS)

- [ ] **2.5.1** Create control buttons HTML
  ```html
  <div class="controls">
    <a id="play_0" href="#" onclick="togglePlay(0)">Play</a>
    <a id="addmin_0" href="#" onclick="Timer.addMinute(0)">+Min</a>
    <a id="submin_0" href="#" onclick="Timer.subtractMinute(0)">-Min</a>
    <a id="nextround_0" href="#" onclick="Timer.nextRound(0)">Next Round</a>
    <a id="reset_0" href="#" onclick="Timer.reset(0)">Reset</a>
  </div>
  ```
- [ ] **2.5.2** Implement togglePlay(gameId) function
- [ ] **2.5.3** Update play button text (Play/Pause) based on state
- [ ] **2.5.4** Style control buttons
- [ ] **2.5.5** Add Finalize button for ending tournament

---

## Phase 3: Firebase Integration

### Task 3.1: Initialize Firebase
**File**: `timer.html` (JavaScript)

- [ ] **3.1.1** Copy Firebase config from leaderboard.html
- [ ] **3.1.2** Initialize Firebase app
- [ ] **3.1.3** Initialize Firestore and Functions
- [ ] **3.1.4** Verify PokerAPI is available from firebase-api.js

### Task 3.2: Implement Leaderboard Data Fetching
**File**: `timer.html` (JavaScript)

- [ ] **3.2.1** Create loadLeaderboard(venue) async function
- [ ] **3.2.2** Call PokerAPI.getLeaderboard({ venue })
- [ ] **3.2.3** Store result in leagueData variable
- [ ] **3.2.4** Extract bounty data (filter players with bounties > 0)
- [ ] **3.2.5** Call render functions for leaderboard and bounty
- [ ] **3.2.6** Handle errors gracefully (show last data or placeholder)

### Task 3.3: Set Up Auto-Refresh
**File**: `timer.html` (JavaScript)

- [ ] **3.3.1** Set up setInterval for 60-second refresh
- [ ] **3.3.2** Add manual refresh button/link
- [ ] **3.3.3** Show loading indicator during refresh
- [ ] **3.3.4** Update timestamp of last refresh

### Task 3.4: Build Leaderboard Display
**File**: `timer.html` (HTML + CSS + JS)

- [ ] **3.4.1** Create leaderboard container HTML
- [ ] **3.4.2** Create renderLeaderboard(data) function
- [ ] **3.4.3** Generate multi-column layout (4 columns of 15 players)
- [ ] **3.4.4** Apply rank-based color highlighting
- [ ] **3.4.5** Format: "Rank  Name........Points"
- [ ] **3.4.6** Add title with context ("The Championship @9")
- [ ] **3.4.7** Style for readability at distance

### Task 3.5: Build Bounty Display
**File**: `timer.html` (HTML + CSS + JS)

- [ ] **3.5.1** Create bounty container HTML
- [ ] **3.5.2** Create renderBountyList(data) function
- [ ] **3.5.3** Sort by bounty count descending
- [ ] **3.5.4** Generate 2-column layout
- [ ] **3.5.5** Format: "Rank  Name........Count"
- [ ] **3.5.6** Add title ("Bounty Final @7")

---

## Phase 4: Google Sheets Integration (Hand of Night)

### Task 4.1: Add GAS Function
**File**: `../backend.gs` (Google Apps Script)

- [ ] **4.1.1** Add getHandOfNight(venue) function to GAS
- [ ] **4.1.2** Read hand value from designated cell
- [ ] **4.1.3** Read bonus value from designated cell
- [ ] **4.1.4** Return { hand, bonus, display } object
- [ ] **4.1.5** Handle venue parameter (tight/corgi)
- [ ] **4.1.6** Deploy updated GAS (new version)

### Task 4.2: Create Timer Settings in Sheets
**File**: Google Sheets

- [ ] **4.2.1** Create "Timer Settings" tab or designated area
- [ ] **4.2.2** Add cells for: TightEnd_Hand, TightEnd_Bonus
- [ ] **4.2.3** Add cells for: Corgi_Hand, Corgi_Bonus
- [ ] **4.2.4** Document cell locations for directors

### Task 4.3: Fetch Hand of Night in Timer
**File**: `timer.html` (JavaScript)

- [ ] **4.3.1** Create fetchHandOfNight(venue) async function
- [ ] **4.3.2** Call GAS webhook with action=getHandOfNight
- [ ] **4.3.3** Parse response and store in handOfNight variable
- [ ] **4.3.4** Handle errors (show placeholder or last value)
- [ ] **4.3.5** Call on page load

### Task 4.4: Display Hand of Night
**File**: `timer.html` (HTML + CSS + JS)

- [ ] **4.4.1** Add HotN placeholders in header corners
- [ ] **4.4.2** Create renderHandOfNight(data) function
- [ ] **4.4.3** Format display: "A K | 500"
- [ ] **4.4.4** Handle suit notation (/s=♠, etc.)
- [ ] **4.4.5** Mirror display in footer

---

## Phase 5: Multi-Venue Support

### Task 5.1: Implement Venue Detection
**File**: `timer.html` (JavaScript)

- [ ] **5.1.1** Parse URL parameter: `?venue=tight`
- [ ] **5.1.2** Store currentVenue variable
- [ ] **5.1.3** Default to 'tight' if not specified
- [ ] **5.1.4** Create getVenueConfig(venue) function

### Task 5.2: Create Venue Configuration
**File**: `timer.html` (JavaScript)

- [ ] **5.2.1** Define venue config object
  ```javascript
  const VENUES = {
    tight: {
      name: "Tight-End",
      fullName: "Tight-End & All-In Poker Club",
      schedule: "NLTH Poker @7PM & @9PM",
      logo: "tight-end-logo.png"
    },
    corgi: {
      name: "Wild Corgi",
      fullName: "Wild Corgi & All-In Poker Club",
      schedule: "NLTH Poker @7PM & @9PM",
      logo: "wild-corgi-logo.png"
    }
  };
  ```
- [ ] **5.2.2** Add logo image assets (or use existing)

### Task 5.3: Apply Venue Branding
**File**: `timer.html` (HTML + CSS + JS)

- [ ] **5.3.1** Update header text based on venue
- [ ] **5.3.2** Update logo images based on venue
- [ ] **5.3.3** Update footer to match header
- [ ] **5.3.4** Pass venue to data fetch functions

### Task 5.4: Add Venue Switching
**File**: `timer.html` (HTML + JS)

- [ ] **5.4.1** Add venue links in menu ("Corgi" / "Tight")
- [ ] **5.4.2** Highlight current venue
- [ ] **5.4.3** Navigate to same page with different venue param

---

## Phase 6: Two-Game System

### Task 6.1: Create Dual Game Layout
**File**: `timer.html` (HTML + CSS)

- [ ] **6.1.1** Create game_0 container (Game 1)
- [ ] **6.1.2** Create game_1 container (Game 2)
- [ ] **6.1.3** Set up flexbox/grid for side-by-side layout
- [ ] **6.1.4** Style Game 2 as hidden by default

### Task 6.2: Implement Game 2 Activation
**File**: `timer.html` (JavaScript)

- [ ] **6.2.1** Create showGame2() function
- [ ] **6.2.2** Create hideGame2() function
- [ ] **6.2.3** Toggle visibility with CSS class
- [ ] **6.2.4** Shrink Game 1 when Game 2 is shown
- [ ] **6.2.5** Check URL hash for #game2 on load

### Task 6.3: Add Game Toggle Controls
**File**: `timer.html` (HTML + JS)

- [ ] **6.3.1** Add "Show G1" / "Hide G1" links
- [ ] **6.3.2** Add "Show G2" / "Hide G2" links
- [ ] **6.3.3** Update link visibility based on current state
- [ ] **6.3.4** Wire up click handlers

### Task 6.4: Independent Timer States
**File**: `timer.html` (JavaScript)

- [ ] **6.4.1** Ensure Timer object handles both games independently
- [ ] **6.4.2** Each game has own level, time, pause state
- [ ] **6.4.3** Controls only affect their respective game
- [ ] **6.4.4** Display updates independently

---

## Phase 7: Header/Footer & Visual Polish

### Task 7.1: Build Header Component
**File**: `timer.html` (HTML + CSS)

- [ ] **7.1.1** Create header structure with 3 sections (left, center, right)
- [ ] **7.1.2** Add Hand of Night displays to left and right
- [ ] **7.1.3** Add venue logo and text to center
- [ ] **7.1.4** Apply rainbow gradient background
- [ ] **7.1.5** Style for high visibility

### Task 7.2: Build Footer Component
**File**: `timer.html` (HTML + CSS)

- [ ] **7.2.1** Mirror header structure in footer
- [ ] **7.2.2** Same content as header for symmetry
- [ ] **7.2.3** Apply matching rainbow gradient

### Task 7.3: Build Menu Bar
**File**: `timer.html` (HTML + CSS)

- [ ] **7.3.1** Create horizontal menu layout
- [ ] **7.3.2** Add all control links
- [ ] **7.3.3** Style for minimal visual impact
- [ ] **7.3.4** Add hover states

### Task 7.4: Add Visual Effects
**File**: `timer.html` (CSS)

- [ ] **7.4.1** Add glow effect to timer containers
- [ ] **7.4.2** Add pulse animation for level changes
- [ ] **7.4.3** Add flash animation for low time warning
- [ ] **7.4.4** Add transition for Game 2 appearance
- [ ] **7.4.5** Test all animations for performance

---

## Phase 8: Testing & Deployment

### Task 8.1: Local Testing
- [ ] **8.1.1** Run `firebase serve --only hosting`
- [ ] **8.1.2** Test timer countdown functionality
- [ ] **8.1.3** Test all control buttons
- [ ] **8.1.4** Test leaderboard data loading
- [ ] **8.1.5** Test bounty data loading
- [ ] **8.1.6** Test Hand of Night loading
- [ ] **8.1.7** Test venue switching
- [ ] **8.1.8** Test Game 2 activation

### Task 8.2: Cross-Browser Testing
- [ ] **8.2.1** Test in Chrome (primary)
- [ ] **8.2.2** Test in Edge (Surface)
- [ ] **8.2.3** Test in Firefox (backup)
- [ ] **8.2.4** Fix any browser-specific issues

### Task 8.3: Responsive Testing
- [ ] **8.3.1** Test at 1920x1080 (TV)
- [ ] **8.3.2** Test at 1366x768 (laptop)
- [ ] **8.3.3** Test at tablet resolution
- [ ] **8.3.4** Verify readability at all sizes

### Task 8.4: Deploy to Firebase
- [ ] **8.4.1** Run `firebase deploy --only hosting`
- [ ] **8.4.2** Test at https://poker-club.example/timer.html
- [ ] **8.4.3** Test both venues live
- [ ] **8.4.4** Verify data refreshes work

### Task 8.5: Deploy GAS Updates
- [ ] **8.5.1** Open GAS project
- [ ] **8.5.2** Deploy new version
- [ ] **8.5.3** Test getHandOfNight endpoint
- [ ] **8.5.4** Verify timer can fetch data

---

## Summary: Task Count

| Phase | Tasks | Subtasks |
|-------|-------|----------|
| 1. Setup | 2 | 12 |
| 2. Timer Core | 5 | 30 |
| 3. Firebase | 5 | 20 |
| 4. GAS/Sheets | 4 | 15 |
| 5. Multi-Venue | 4 | 12 |
| 6. Two-Game | 4 | 14 |
| 7. Visual Polish | 4 | 17 |
| 8. Testing | 5 | 20 |
| **Total** | **33** | **140** |
