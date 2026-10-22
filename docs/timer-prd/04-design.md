# 04 - UI/UX Design Specification

## 4.1 Layout Structure

### 4.1.1 Full Page Layout (1920x1080 reference)
```
┌─────────────────────────────────────────────────────────────────────────┐
│ HEADER BAR (rainbow gradient)                                            │
│ [HotN: A K|500]  [LOGO] Venue Name - NLTH Poker @7PM & @9PM  [500|A K]  │
├─────────────────────────────────────────────────────────────────────────┤
│ MENU BAR (dark, small text)                                              │
│ Show G1 | Hide G1 | Show G2 | Hide G2 | Points|Pinks | Edit | Venues   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────────┐  ┌─────────────────────────────┐       │
│  │        GAME 1 TIMER         │  │        GAME 2 TIMER         │       │
│  │  ┌─────────┬───────────┐   │  │  (Hidden until activated)   │       │
│  │  │ Game 1  │ Blinds Now│   │  │                             │       │
│  │  │  R1     │   25      │   │  │                             │       │
│  │  │         │   50      │   │  │                             │       │
│  │  │ 12:00   │           │   │  │                             │       │
│  │  │         │ Next Blinds│  │  │                             │       │
│  │  │         │   50      │   │  │                             │       │
│  │  │         │   100     │   │  │                             │       │
│  │  └─────────┴───────────┘   │  │                             │       │
│  │ [Play][+Min][-Min][Next][Reset]│                             │       │
│  └─────────────────────────────┘  └─────────────────────────────┘       │
│                                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│ LOWER SECTION                                                            │
│ ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────────────┐  │
│ │   LEADERBOARD    │ │   BOUNTY LIST    │ │   TABLE & SEAT MAP       │  │
│ │  (4 columns)     │ │   (2 columns)    │ │   [Bar] [Patio] [Door]   │  │
│ │ 1. Bing.....320  │ │ 1. Bing......13  │ │   [25][50][100]          │  │
│ │ 2. Steven...305  │ │ 2. Jacob......8  │ │   [500][1K]              │  │
│ │ ...              │ │ ...              │ │                          │  │
│ └──────────────────┘ └──────────────────┘ └──────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────────┤
│ FOOTER BAR (rainbow gradient, mirrors header)                            │
│ [HotN: A K|500]  [LOGO] Venue Name - NLTH Poker @7PM & @9PM  [500|A K]  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.1.2 CSS Grid Structure
```css
.timer-page {
  display: grid;
  grid-template-rows: auto auto 1fr auto auto;
  height: 100vh;
}

/* Row 1: Header */
/* Row 2: Menu */
/* Row 3: Game Area (flexible) */
/* Row 4: Lower Section */
/* Row 5: Footer */
```

## 4.2 Color Scheme

### 4.2.1 Background
- **Page background**: Dark gray/black (#1a1a1a)
- **Header/Footer**: Rainbow gradient (linear-gradient)
```css
background: linear-gradient(90deg,
  #ff0000, #ff7f00, #ffff00, #00ff00,
  #0000ff, #4b0082, #8f00ff, #ff0000);
```

### 4.2.2 Game Area
- **Timer background**: Black (#000000) with colored border
- **Border**: Bright yellow/green (#ccff00) glow effect
```css
border: 3px solid #ccff00;
box-shadow: 0 0 20px #ccff00;
```

### 4.2.3 Text Colors
| Element | Color | Notes |
|---------|-------|-------|
| Timer digits | Lime green (#ccff00) | Large, bold |
| Blinds "Now" | Red (#ff0000) for small, Yellow (#ffff00) for big | |
| Blinds "Next" | Blue (#00aaff) | Smaller text |
| Round number | Red (#ff0000) | |
| Game label | White (#ffffff) | |
| Break text | Magenta (#ff00ff) | |
| Leaderboard | White text, colored highlights | |

### 4.2.4 Leaderboard Highlighting
| Rank | Color | CSS Class |
|------|-------|-----------|
| 1-5 | Bright green (#00ff00) | .rank-top5 |
| 6-10 | Yellow (#ffff00) | .rank-top10 |
| 11-15 | Light blue (#00aaff) | .rank-top15 |
| 16+ | White (#ffffff) | .rank-default |

## 4.3 Typography

### 4.3.1 Font Stack
```css
font-family: 'Arial Black', 'Impact', sans-serif;
```

### 4.3.2 Font Sizes (relative to viewport)
| Element | Size | Notes |
|---------|------|-------|
| Timer countdown | 15vw | Massive, dominant |
| Round number | 5vw | |
| Blinds values | 8vw | |
| Game label | 4vw | |
| Menu text | 1.5vw | |
| Leaderboard | 1.8vh | Fits 15 rows |
| Header text | 2.5vw | |

### 4.3.3 Responsive Scaling
```javascript
function flexFont() {
  // Adjust font sizes based on viewport
  const vw = window.innerWidth / 100;
  document.documentElement.style.setProperty('--vw', vw + 'px');
}
window.addEventListener('resize', flexFont);
```

## 4.4 Component Designs

### 4.4.1 Timer Display
```
┌──────────────────────────────────┐
│ Game 1          R1               │ <- Game label + Round
│                                  │
│         12 : 00                  │ <- Large countdown
│                                  │
│   Blinds Now        Next Blinds  │
│      25                 50       │
│      50                100       │
│                                  │
│ [Play] [+Min] [-Min] [Next] [Reset] │
└──────────────────────────────────┘
```

### 4.4.2 Header/Footer Bar
```
┌──────────────────────────────────────────────────────┐
│ A K | 500    [LOGO] Tight-End... [LOGO]    500 | A K │
└──────────────────────────────────────────────────────┘
     ↑              ↑                            ↑
  Hand of       Venue Logo                  Mirrored
   Night        + Text                      for symmetry
```

### 4.4.3 Leaderboard Display
```
┌────────────────────────────────────────┐
│ The Championship @9                     │  <- Title
├────────────────────────────────────────┤
│ 1  Bing          320 │ 16 Willie...100 │  <- 4 columns
│ 2  Steven...     305 │ 17 John F... 70 │
│ 3  Hunter...     295 │ 18 Biba...   60 │
│ ...                  │ ...             │
│ 15 John C...     125 │ 30 Alan...   60 │
└────────────────────────────────────────┘
```

### 4.4.4 Bounty Display
```
┌────────────────────────────────────────┐
│ Bounty Final @7                        │
├────────────────────────────────────────┤
│ 1  Bing         13 │ 16 Devon...    3 │
│ 2  Jacob...      8 │ 17 Jamie...    3 │
│ ...                │ ...              │
└────────────────────────────────────────┘
```

### 4.4.5 Seat Map (Optional)
```
┌──────────────────────────────────┐
│ Table & Seat Select Map          │
│ Table=Card ♠♥♣♦ Seat=Card Number │
├──────────────────────────────────┤
│  Bar ♥     Patio ♣     Door ♦   │
│                                  │
│    [25]   [50]   [100]          │
│         [500]   [1K]            │
└──────────────────────────────────┘
```

## 4.5 Animations & Transitions

### 4.5.1 Level Change
```css
.blinds-transition {
  animation: pulse 0.5s ease-in-out;
}

@keyframes pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.1); }
}
```

### 4.5.2 Timer Warning (last 60 seconds)
```css
.timer-warning {
  animation: flash 1s infinite;
}

@keyframes flash {
  0%, 100% { color: #ccff00; }
  50% { color: #ff0000; }
}
```

### 4.5.3 Game 2 Activation
```css
.game-2-appear {
  animation: slideIn 0.5s ease-out;
}

.game-1-shrink {
  transition: all 0.5s ease-out;
}
```

## 4.6 Responsive Behavior

### 4.6.1 Breakpoints
| Breakpoint | Layout Changes |
|------------|----------------|
| > 1400px | Full layout, 4-column leaderboard |
| 1000-1400px | 3-column leaderboard, smaller timer |
| 768-1000px | 2-column leaderboard, stacked games |
| < 768px | Single column, essential info only |

### 4.6.2 TV/Projector Mode (Default)
- Optimized for 1920x1080
- Large fonts, high contrast
- No scrolling needed

### 4.6.3 Tablet Mode (Surface)
- Touch-friendly control buttons
- Larger tap targets (min 44px)
- Optionally hide non-essential elements
