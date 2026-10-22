# 06 - Testing Plan

## 6.1 Unit Test Cases

### 6.1.1 Timer Logic Tests

| Test ID | Test Case | Expected Result |
|---------|-----------|-----------------|
| T-001 | Timer starts from paused state | Timer begins counting down |
| T-002 | Timer pauses from running state | Countdown stops, time preserved |
| T-003 | Add minute adds 60 seconds | Time increases by 60 |
| T-004 | Subtract minute removes 60 seconds | Time decreases by 60 |
| T-005 | Subtract minute at 0:30 goes to 0:00 | Time cannot go negative |
| T-006 | Next Round advances level | Level increments, time resets |
| T-007 | Reset restores full level time | Time returns to level duration |
| T-008 | Level auto-advances at 0:00 | Next level starts automatically |
| T-009 | Break level displays correctly | Shows "Break" instead of blinds |
| T-010 | Chip-up level displays correctly | Shows chip-up message |

### 6.1.2 Blind Display Tests

| Test ID | Test Case | Expected Result |
|---------|-----------|-----------------|
| B-001 | Level 1 shows 25/50 | "25" over "50" displayed |
| B-002 | Level 5 shows 500/1000 | "500" over "1000" displayed |
| B-003 | Level 8 shows "1/2" (chips) | After chip-up, displays chip format |
| B-004 | Break shows "Break" | No blind values shown |
| B-005 | Next blinds preview correct | Shows next level's values |
| B-006 | Break preview shows next blind | Shows "100/200" not "Break" as next |

### 6.1.3 Data Fetch Tests

| Test ID | Test Case | Expected Result |
|---------|-----------|-----------------|
| D-001 | Leaderboard loads for Tight End | Standings filtered to venue |
| D-002 | Leaderboard loads for Wild Corgi | Standings filtered to venue |
| D-003 | Bounty list extracted from leaderboard | Only players with bounties > 0 |
| D-004 | Hand of Night loads from GAS | Hand and bonus displayed |
| D-005 | Data refresh after 60 seconds | New data loaded automatically |
| D-006 | Network error handled gracefully | Shows last data or error state |

---

## 6.2 Integration Test Cases

### 6.2.1 Firebase Integration

| Test ID | Test Case | Steps | Expected Result |
|---------|-----------|-------|-----------------|
| FI-001 | Firebase initializes | Load page | No console errors |
| FI-002 | PokerAPI available | Check window.PokerAPI | Object exists |
| FI-003 | getLeaderboard returns data | Call API | Array of standings returned |
| FI-004 | Data matches Firestore | Compare with Firebase console | Values match |

### 6.2.2 GAS Integration

| Test ID | Test Case | Steps | Expected Result |
|---------|-----------|-------|-----------------|
| GI-001 | GAS endpoint responds | Fetch with action=getHandOfNight | 200 OK |
| GI-002 | Hand of Night data correct | Compare with Sheet | Values match |
| GI-003 | Venue parameter works | Test tight and corgi | Correct data per venue |

---

## 6.3 UI/UX Test Cases

### 6.3.1 Visual Tests

| Test ID | Test Case | Expected Result |
|---------|-----------|-----------------|
| V-001 | Timer visible from 10 feet | Countdown readable at distance |
| V-002 | Blinds visible from 10 feet | Values readable at distance |
| V-003 | Leaderboard readable | Names and points clear |
| V-004 | Rainbow gradient displays | Smooth gradient in header/footer |
| V-005 | Venue logo displays | Correct logo for selected venue |
| V-006 | Color highlighting correct | Top 5 green, 6-10 yellow, etc. |

### 6.3.2 Responsive Tests

| Test ID | Resolution | Expected Result |
|---------|------------|-----------------|
| R-001 | 1920x1080 | Full layout, 4-column leaderboard |
| R-002 | 1366x768 | Adjusted layout, readable |
| R-003 | 1024x768 | Tablet layout works |
| R-004 | 800x600 | Minimum supported, essential visible |

### 6.3.3 Interaction Tests

| Test ID | Test Case | Expected Result |
|---------|-----------|-----------------|
| I-001 | Click Play button | Timer starts/pauses |
| I-002 | Click +Min button | Time increases |
| I-003 | Click -Min button | Time decreases |
| I-004 | Click Next Round | Level advances |
| I-005 | Click Reset | Time resets |
| I-006 | Click venue link | Page reloads with new venue |
| I-007 | Click Show G2 | Game 2 appears |
| I-008 | Click Hide G1 | Game 1 hides |

---

## 6.4 Cross-Browser Tests

| Browser | Version | Tests to Run |
|---------|---------|--------------|
| Chrome | Latest | All tests |
| Edge | Latest | Core functionality |
| Firefox | Latest | Core functionality |

### 6.4.1 Browser-Specific Checks
- [ ] CSS Grid renders correctly
- [ ] CSS animations work
- [ ] Fetch API works
- [ ] setInterval timing accurate
- [ ] ES6 features supported

---

## 6.5 Performance Tests

| Test ID | Metric | Target |
|---------|--------|--------|
| P-001 | Page load time | < 3 seconds |
| P-002 | Data fetch time | < 2 seconds |
| P-003 | Timer tick accuracy | ±100ms |
| P-004 | Memory usage (1 hour) | No leaks, stable |
| P-005 | CPU usage (idle) | < 5% |

---

## 6.6 End-to-End Test Scenarios

### Scenario 1: Full Tournament Night
```
1. Open timer.html?venue=tight
2. Verify leaderboard loads
3. Verify bounty list loads
4. Verify Hand of Night shows
5. Click Play to start Game 1
6. Let timer run through Level 1
7. Verify auto-advance to Level 2
8. Click +Min, verify time increases
9. Click -Min, verify time decreases
10. Click Next Round, verify Level 3
11. At break, verify display changes
12. Click Show G2
13. Verify Game 2 appears, Game 1 shrinks
14. Start Game 2 timer independently
15. Verify both timers run independently
16. Switch to venue=corgi
17. Verify data updates for Corgi
18. Run for 30+ minutes, verify stability
```

### Scenario 2: Data Refresh
```
1. Open timer with initial data
2. Note leaderboard values
3. Update Firestore (add elimination)
4. Wait 60 seconds
5. Verify leaderboard updates
6. Click manual refresh button
7. Verify immediate update
```

### Scenario 3: Hand of Night Update
```
1. Open timer, note HotN display
2. Update Google Sheet with new hand
3. Reload page
4. Verify new hand displays
```

---

## 6.7 Verification Checklist

### Pre-Deployment
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] Tested on Chrome, Edge, Firefox
- [ ] Tested at 1920x1080 resolution
- [ ] Tested on Windows Surface
- [ ] No console errors
- [ ] Data loads correctly for both venues
- [ ] Timer functions correctly
- [ ] Two-game system works

### Post-Deployment
- [ ] Live URL accessible
- [ ] Firebase connection works
- [ ] GAS connection works
- [ ] Leaderboard updates in real-time
- [ ] Timer accurate over extended period
- [ ] Venue switching works
- [ ] No visual glitches

---

## 6.8 Known Issues / Limitations

| Issue | Description | Workaround |
|-------|-------------|------------|
| Timer not synced | Page refresh resets timer | Directors must track manually |
| No remote control | Controls only on display device | Use device directly |
| 60s data delay | Data refreshes every 60s | Manual refresh available |
| Single device | No multi-screen sync | Each display independent |

---

## 6.9 Regression Tests

After any code change, run:
1. T-001 through T-010 (Timer basics)
2. D-001 through D-004 (Data loading)
3. V-001, V-002 (Visual checks)
4. Scenario 1 abbreviated (5 minutes)
