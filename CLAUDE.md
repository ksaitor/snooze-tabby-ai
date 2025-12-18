# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Snooze Tabby is a Chrome Extension (Manifest V3) that allows users to schedule tabs to be reopened at specific times. The extension provides quick snooze options, custom scheduling, and recurring tab reopening.

Project context: https://x.com/ksaitor/status/1944997383441731953

## Development Commands

Since this is a Chrome extension with no build step, there are no build/test commands:

```bash
# No build step required
npm run build  # Will echo "No build step required"

# No tests configured
npm run test   # Will echo "No tests configured yet"
```

To test changes, load the extension in Chrome:
1. Navigate to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the project directory
4. Reload the extension after making changes

## Architecture

### Core Files

- **manifest.json**: Extension configuration, defines service worker, permissions, and keyboard shortcuts
- **background.js**: Service worker handling all extension logic (alarms, storage, tab management)
- **popup.html**: Extension popup UI with two tabs (Snooze and History)
- **popup.js**: Popup UI interactions and event handlers

### Key Components

**Service Worker (background.js)**:
- Listens for keyboard shortcuts via `chrome.commands.onCommand`
- Handles browser startup/installation events to recover missed tabs
- Manages Chrome alarms API for scheduled tab reopening
- Implements persistence mechanisms:
  - Startup recovery (`checkForMissedTabs`)
  - Periodic checks every 15 minutes
  - Orphaned alarm cleanup
- Functions organized by purpose:
  - `snoozeTab()`: Quick snooze with delay in milliseconds
  - `snoozeTomorrowAt9AM()`: Special case for tomorrow at 9AM
  - `scheduleCustomSnooze()`: User-selected date/time
  - `scheduleRecurringTab()` and `scheduleRecurringSnooze()`: Recurring schedules

**Storage Pattern**:
- Uses `chrome.storage.local` with keys prefixed by `snooze-{timestamp}`
- Each stored item contains:
  ```javascript
  {
    url: string,
    title: string,
    timestamp: number,
    scheduledFor: number,
    recurring: boolean,
    recurringType?: 'daily' | 'weekly' | 'monthly' | 'yearly',
    recurringTime?: string,  // HH:MM format
    selectedDays?: number[]  // 0-6 for weekly recurring
  }
  ```
- Alarms are created with matching names to storage keys

**Recurring Logic**:
- Weekly recurring supports multiple selected days (background.js:281-298, background.js:379-397)
- Next occurrence calculated based on current day and selected days
- When alarm fires for recurring tab, it reopens the tab and schedules the next occurrence

**Popup UI**:
- Two-tab interface: Snooze and History
- Snooze tab:
  - Quick options (4 hours, tomorrow 9AM, one month)
  - Custom date/time picker
  - Recurring scheduler with weekly day selector (shown when "Weekly" is selected)
- History tab:
  - Lists all snoozed tabs sorted by scheduled time
  - Shows time until reopening
  - Allows removal of snoozed tabs
  - Export/import functionality for backup/restore

### Message Passing

Background script listens for messages from popup:
- `{action: 'snooze', type: '4-hours'|'tomorrow-9am'|'one-month'}` - Quick snooze
- `{action: 'snoozeTab', type: 'custom', date: ISO8601}` - Custom date
- `{action: 'snoozeTab', type: 'recurring', recurringType, recurringTime, selectedDays}` - Recurring

### Keyboard Shortcuts

Defined in manifest.json:
- Shift+Alt+1 (Mac) / Shift+Ctrl+1 (Windows): 4 hours
- Shift+Alt+2 (Mac) / Shift+Ctrl+2 (Windows): Tomorrow 9AM
- Shift+Alt+3 (Mac) / Shift+Ctrl+3 (Windows): One month

Note: README shows Shift+Command but manifest uses Shift+Alt for Mac.

### Persistence Mechanisms

The extension ensures tabs are never lost through multiple layers:
1. Startup event listener checks for missed tabs
2. Installation event listener handles updates/reinstalls
3. Periodic alarm every 15 minutes verifies no tabs were missed
4. Orphaned alarm cleanup prevents stale alarms
5. Alarms use `delayInMinutes` instead of absolute timestamps for better persistence across browser restarts

### Error Handling

- Tab data validation before reopening (background.js:131-136)
- Error logging throughout with `console.error`
- Notifications shown for success/failure states
- Try-catch blocks for critical operations
