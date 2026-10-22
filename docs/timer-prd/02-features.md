# 02 - Feature Requirements

## 2.1 Blind Timer

### 2.1.1 Timer Display
- **Large countdown display** in MM:SS format (e.g., "12:00")
- **Round indicator** showing current round number (e.g., "R1", "R2", "R10")
- **Game label** showing "Game 1" or "Game 2"
- Timer font should be highly visible from across the room

### 2.1.2 Blind Level Display
- **"Blinds Now"** section showing current small/big blind
- **"Next Blinds"** section showing upcoming level
- After Quick Chip-up, display as chip counts (e.g., "1/2" = 1 chip / 2 chips @ 5K each)
- Special displays for breaks: "Break", "Break & Chip Up", "Quick Chip-up"

### 2.1.3 Timer Controls
| Control | Function |
|---------|----------|
| **Play/Pause** | Toggle timer running/paused |
| **+Min** | Add 1 minute to current level |
| **-Min** | Subtract 1 minute from current level |
| **Next Round** | Advance to next blind level immediately |
| **Reset** | Reset current level to full time |
| **Finalize** | End tournament for this game |

### 2.1.4 Blind Structure
Complete structure with 13+ levels:

| Level | Name | Duration | Small | Big | Notes |
|-------|------|----------|-------|-----|-------|
| 0 | Seat Selection | 5 min | - | - | "Draw Card for Table/Seat" |
| 1 | Round 1 | 12 min | 25 | 50 | |
| 2 | Round 2 | 12 min | 50 | 100 | |
| B1 | Break | 8 min | - | - | |
| 3 | Round 3 | 12 min | 100 | 200 | |
| 4 | Round 4 | 12 min | 200 | 400 | |
| B2 | Break & Chip Up | 10 min | - | - | Remove 25s |
| 5 | Round 5 | 12 min | 500 | 1000 | |
| 6 | Round 6 | 12 min | 1000 | 2000 | |
| 7 | Round 7 | 12 min | 2000 | 4000 | |
| B3 | Quick Chip-up | 3 min | - | - | Convert to 5K chips |
| 8 | Round 8 | 12 min | 5K | 10K | Display: "1/2" |
| 9 | Round 9 | 12 min | 10K | 20K | Display: "2/4" |
| 10 | Round 10 | 12 min | 20K | 40K | Display: "4/8" |
| 11 | Round 11 | 12 min | 40K | 80K | Display: "8/16" |
| 12 | Round 12 | 12 min | 80K | 160K | Display: "16/32" |
| 13 | Round 13 | 12 min | 160K | 320K | Display: "32/64" |

*Continues doubling if needed beyond R13*

---

## 2.2 Leaderboard Display

### 2.2.1 Data Source
- **Firebase Firestore** via existing `PokerAPI.getLeaderboard({ venue })`
- Returns current season standings with points, bounties, games played

### 2.2.2 Display Format
- Ranked list showing: Rank, Player Name, Points
- Top players highlighted (positions 1-5 green, 6-10 different color)
- Show 15-30 players per column (multiple columns as needed)
- Title: "The Championship @9" or similar based on context

### 2.2.3 Refresh Behavior
- Auto-refresh every 60 seconds
- Manual refresh available via "Points|Pinks" toggle button

---

## 2.3 Bounty Display

### 2.3.1 Data Source
- **Firebase Firestore** - bounty counts included in leaderboard response
- Filter to players with bounties > 0

### 2.3.2 Display Format
- Ranked list showing: Rank, Player Name, Bounty Count
- Title: "Bounty Final @7" or similar
- Show top 30 bounty leaders

### 2.3.3 Refresh Behavior
- Synced with leaderboard refresh (60 seconds)

---

## 2.4 Hand of Night Display

### 2.4.1 Data Source
- **Google Sheets** via GAS webhook
- New GAS action: `?action=getHandOfNight&venue=tight`

### 2.4.2 Display Format
- Show hand in header corners: "A K | 500"
- Format: "[Hand] | [Bonus Points]"
- Support suit notation: /s=♠, /h=♥, /c=♣, /d=♦

### 2.4.3 Configuration
- Hand and bonus amount set in Google Sheets
- One per venue per night

---

## 2.5 Multi-Venue Support

### 2.5.1 Venue Selection
- URL parameter: `?venue=tight` or `?venue=corgi`
- Default to Tight End if not specified

### 2.5.2 Venue-Specific Elements
| Element | Tight End | Wild Corgi |
|---------|-----------|------------|
| **Logo** | Tight End logo | Wild Corgi logo |
| **Header Text** | "Tight-End & All-In Poker Club" | "Wild Corgi & All-In Poker Club" |
| **Schedule** | "NLTH Poker @7PM & @9PM" | Venue-specific times |
| **Leaderboard Data** | Filtered to Tight End | Filtered to Wild Corgi |
| **Bounty Data** | Filtered to Tight End | Filtered to Wild Corgi |

### 2.5.3 Switching Venues
- Change URL parameter and reload
- Or provide venue toggle in menu (future)

---

## 2.6 Two-Game System

### 2.6.1 Game 1 (7PM Game)
- **Default state**: Large display, full visibility
- Occupies majority of game area
- Independent timer controls

### 2.6.2 Game 2 (9PM Game)
- **Default state**: Hidden (display: none)
- **Activated state**: Visible, takes prominent position
- Activation methods:
  - URL hash: `#game2`
  - Button click in menu
  - Automatic at configured time (future)

### 2.6.3 Layout Behavior
- When Game 2 activates: Game 1 shrinks to smaller size
- Rationale: Players still in Game 1 are closer to TV, need less screen space
- Both games run independently with separate timers

---

## 2.7 Menu/Controls

### 2.7.1 Menu Links
| Link | Function |
|------|----------|
| Show G1 / Hide G1 | Toggle Game 1 visibility |
| Show G2 / Hide G2 | Toggle Game 2 visibility |
| Show Players / Hide Players | Toggle leaderboard/bounty section |
| Points\|Pinks | Refresh/toggle leaderboard display |
| Edit | Open configuration page (future) |
| Corgi / Tight | Switch venues |

### 2.7.2 Right-Click Context Menu (Optional)
- Header text customization
- Quick settings access
