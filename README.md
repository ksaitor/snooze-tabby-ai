# Snooze Tabby - Chrome Extension

A Chrome extension that allows you to snooze tabs for later with flexible scheduling options.

> 📢 **For more context about this project**, check out the
> [original tweet](https://x.com/ksaitor/status/1944997383441731953) that inspired its creation.

## Features

- **Quick Snooze Options**:

  - In 4 hours
  - Tomorrow 9AM
  - In one month

- **Custom Scheduling**: Pick any date and time using a date picker
- **Recurring Snooze**: Set tabs to reopen daily, monthly, or yearly at specific times
- **Persistent Scheduling**: Tabs will reopen even after computer shutdown or browser closure
- **Keyboard Shortcuts**:
  - `Shift+Command+1` (Mac) / `Shift+Ctrl+1` (Windows/Linux) - Snooze for 4 hours
  - `Shift+Command+2` (Mac) / `Shift+Ctrl+2` (Windows/Linux) - Snooze until tomorrow 9AM
  - `Shift+Command+3` (Mac) / `Shift+Ctrl+3` (Windows/Linux) - Snooze for one month

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the extension folder
5. The extension will now appear in your browser toolbar

## Usage

### Quick Snooze

1. Click the Snooze Tabby icon in the browser toolbar
2. Select one of the quick options (4 hours, tomorrow 9AM, or one month)
3. The current tab will be closed and reopened at the scheduled time

### Custom Date/Time

1. Click the Snooze Tabby icon
2. In the "Pick Date" section, select your desired date and time
3. Click "Schedule"
4. The tab will be closed and reopened at your chosen time

### Recurring Snooze

1. Click the Snooze Tabby icon
2. In the "Recurring" section, choose the frequency (daily, monthly, yearly)
3. Set the time you want the tab to reopen
4. Click "Set Recurring"
5. The tab will be closed and will reopen according to your schedule

### Keyboard Shortcuts

You can use the predefined keyboard shortcuts to quickly snooze tabs without opening the popup:

- `Shift+Command+1` (Mac) / `Shift+Ctrl+1` (Windows/Linux) - 4 hours
- `Shift+Command+2` (Mac) / `Shift+Ctrl+2` (Windows/Linux) - Tomorrow 9AM
- `Shift+Command+3` (Mac) / `Shift+Ctrl+3` (Windows/Linux) - One month

## How It Works

The extension uses Chrome's alarm API to schedule when tabs should be reopened. When you snooze a tab:

1. The tab's URL and title are saved to local storage
2. An alarm is created for the scheduled time
3. The tab is closed
4. When the alarm fires, the tab is reopened at the saved URL

### Persistent Scheduling

The extension includes robust persistence mechanisms to ensure your snoozed tabs are never lost:

- **Startup Recovery**: When the browser starts, the extension checks for any tabs that should have been opened during
  downtime
- **Periodic Checks**: Every 15 minutes, the extension verifies no tabs were missed
- **Alarm Persistence**: Uses Chrome's persistent alarm API to survive browser restarts
- **Error Recovery**: Comprehensive error handling and logging for debugging
- **Data Validation**: Validates stored tab data to prevent corruption

This means your snoozed tabs will reopen reliably even if:

- Your computer is turned off and back on
- The browser is closed and reopened
- The extension is updated or reinstalled
- There are temporary system issues

## Files Structure

- `manifest.json` - Extension configuration
- `background.js` - Service worker handling alarms and tab management
- `popup.html` - Extension popup interface
- `popup.js` - Popup functionality and UI interactions
- `icon.svg` - Extension icon (placeholder)

## Permissions

The extension requires these permissions:

- `tabs` - To access and manage browser tabs
- `activeTab` - To interact with the current active tab
- `alarms` - To schedule when tabs should be reopened
- `storage` - To save tab information temporarily
- `notifications` - To show snooze confirmation messages

## Browser Support

This extension is designed for Chrome (Manifest V3) and should work on:

- Google Chrome (latest)
- Microsoft Edge (Chromium-based)
- Other Chromium-based browsers

## Contributing

Feel free to contribute to this project by submitting issues or pull requests.
