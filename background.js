// Handle keyboard shortcuts
chrome.commands.onCommand.addListener(command => {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]) {
      switch (command) {
        case 'snooze-4-hours':
          snoozeTab(tabs[0], 4 * 60 * 60 * 1000) // 4 hours in milliseconds
          break
        case 'snooze-tomorrow-9am':
          snoozeTomorrowAt9AM(tabs[0])
          break
        case 'snooze-one-month':
          snoozeTab(tabs[0], 30 * 24 * 60 * 60 * 1000) // 30 days in milliseconds
          break
        case 'snooze-next-monday':
          snoozeNextMonday(tabs[0])
          break
      }
    }
  })
})

// Handle startup - check for missed tabs when browser starts
chrome.runtime.onStartup.addListener(() => {
  checkForMissedTabs()
  ensurePeriodicCheck()
  cleanupOrphanedAlarms()
  restoreWokenBadge()
})

// Tab group that collects woken tabs so they don't steal focus
const WOKEN_GROUP_TITLE = 'Woken up 💤'

// Open a woken tab in the background and collect it into the woken group
async function openWokenTab(url) {
  const tab = await chrome.tabs.create({
    url: url,
    active: false, // Don't steal focus from whatever the user is doing
  })

  try {
    const groups = await chrome.tabGroups.query({ title: WOKEN_GROUP_TITLE, windowId: tab.windowId })
    if (groups.length > 0) {
      await chrome.tabs.group({ tabIds: tab.id, groupId: groups[0].id })
    } else {
      const groupId = await chrome.tabs.group({ tabIds: tab.id })
      await chrome.tabGroups.update(groupId, { title: WOKEN_GROUP_TITLE, color: 'purple' })
    }
  } catch (err) {
    // Grouping is best-effort; the tab is already open
    console.error('Failed to group woken tab:', err)
  }

  return tab
}

// Increment the badge counter of woken tabs (cleared when popup opens)
async function incrementWokenBadge(count = 1) {
  try {
    const { wokenCount = 0 } = await chrome.storage.local.get('wokenCount')
    const newCount = wokenCount + count
    await chrome.storage.local.set({ wokenCount: newCount })
    await chrome.action.setBadgeBackgroundColor({ color: '#007bff' })
    await chrome.action.setBadgeText({ text: String(newCount) })
  } catch (err) {
    console.error('Failed to update badge:', err)
  }
}

// Restore badge from storage after browser restart
async function restoreWokenBadge() {
  try {
    const { wokenCount = 0 } = await chrome.storage.local.get('wokenCount')
    if (wokenCount > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: '#007bff' })
      await chrome.action.setBadgeText({ text: String(wokenCount) })
    }
  } catch (err) {
    console.error('Failed to restore badge:', err)
  }
}

// Popup clears the badge when opened
chrome.runtime.onMessage.addListener(request => {
  if (request.action === 'clearWokenBadge') {
    chrome.storage.local.set({ wokenCount: 0 })
    chrome.action.setBadgeText({ text: '' })
  }
})

// Handle installation - also check for missed tabs
chrome.runtime.onInstalled.addListener(() => {
  checkForMissedTabs()
  ensurePeriodicCheck()
  cleanupOrphanedAlarms()
})

// Ensure periodic check alarm is set up
function ensurePeriodicCheck() {
  chrome.alarms
    .get('periodic-check')
    .then(alarm => {
      if (!alarm) {
        chrome.alarms
          .create('periodic-check', { periodInMinutes: 15 })
          .then(() => console.log('Periodic check alarm created'))
          .catch(err => console.error('Failed to create periodic check alarm:', err))
      }
    })
    .catch(err => {
      console.error('Error checking periodic alarm:', err)
      // Create it anyway
      chrome.alarms
        .create('periodic-check', { periodInMinutes: 15 })
        .then(() => console.log('Periodic check alarm created'))
        .catch(err => console.error('Failed to create periodic check alarm:', err))
    })
}

// Clean up orphaned alarms (alarms without corresponding storage data)
function cleanupOrphanedAlarms() {
  chrome.alarms
    .getAll()
    .then(alarms => {
      const snoozeAlarms = alarms.filter(alarm => alarm.name.startsWith('snooze-'))

      if (snoozeAlarms.length > 0) {
        const alarmNames = snoozeAlarms.map(alarm => alarm.name)
        chrome.storage.local.get(alarmNames, data => {
          const orphanedAlarms = alarmNames.filter(name => !data[name])

          orphanedAlarms.forEach(alarmName => {
            chrome.alarms
              .clear(alarmName)
              .then(() => {
                console.log(`Cleaned up orphaned alarm: ${alarmName}`)
              })
              .catch(err => {
                console.error(`Failed to clean up alarm ${alarmName}:`, err)
              })
          })
        })
      }
    })
    .catch(err => {
      console.error('Error cleaning up orphaned alarms:', err)
    })
}

// Handle periodic checks
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'periodic-check') {
    checkForMissedTabs()
  } else if (alarm.name.startsWith('snooze-')) {
    chrome.storage.local.get([alarm.name], result => {
      const tabData = result[alarm.name]
      if (tabData) {
        // Reopen the tab gently: in the background, grouped, with badge + notification
        openWokenTab(tabData.url)
          .then(() => {
            incrementWokenBadge()
            showNotification(`Tab woke up: ${tabData.title}`)
          })
          .catch(err => {
            console.error('Failed to reopen snoozed tab:', err)
            showNotification(`Failed to reopen tab: ${tabData.title}`)
          })

        // Check if it's a recurring snooze
        if (tabData.recurring) {
          scheduleRecurringSnooze(tabData)
        } else {
          // Clean up storage
          chrome.storage.local.remove([alarm.name])
        }
      }
    })
  }
})

// Check for tabs that should have been opened during downtime
async function checkForMissedTabs() {
  try {
    const data = await chrome.storage.local.get(null)
    const now = Date.now()
    const missedTabs = []

    Object.keys(data).forEach(key => {
      if (key.startsWith('snooze-') && data[key].scheduledFor <= now) {
        missedTabs.push({ key, ...data[key] })
      }
    })

    if (missedTabs.length > 0) {
      console.log(`Found ${missedTabs.length} missed tabs, reopening...`)

      for (const tabData of missedTabs) {
        try {
          // Validate tab data
          if (!tabData.url || !tabData.title) {
            console.warn('Invalid tab data, skipping:', tabData)
            await chrome.storage.local.remove([tabData.key])
            continue
          }

          // Open the missed tab gently in the woken group
          try {
            await openWokenTab(tabData.url)
          } catch (err) {
            console.error('Failed to open tab:', err)
            showNotification(`Failed to open tab: ${tabData.title}`)
          }

          // Handle recurring tabs
          if (tabData.recurring) {
            scheduleRecurringSnooze(tabData)
          } else {
            // Clean up storage
            try {
              await chrome.storage.local.remove([tabData.key])
            } catch (err) {
              console.error('Failed to clean up storage:', err)
            }
          }
        } catch (err) {
          console.error('Error processing missed tab:', err)
        }
      }

      // Show notification about reopened tabs
      incrementWokenBadge(missedTabs.length)
      showNotification(`${missedTabs.length} tab(s) reopened from snooze`)
    }
  } catch (err) {
    console.error('Error checking for missed tabs:', err)
  }
}

// Snooze tab function
function snoozeTab(tab, delayMs) {
  const alarmName = `snooze-${Date.now()}`
  const when = Date.now() + delayMs

  // Store tab data
  chrome.storage.local
    .set({
      [alarmName]: {
        url: tab.url,
        title: tab.title,
        timestamp: Date.now(),
        scheduledFor: when,
        recurring: false,
      },
    })
    .then(() => {
      // Create alarm with delay instead of absolute time for better persistence
      return chrome.alarms.create(alarmName, { delayInMinutes: delayMs / (1000 * 60) })
    })
    .then(() => {
      // Close the tab
      return chrome.tabs.remove(tab.id)
    })
    .then(() => {
      // Show notification
      showNotification(`Tab snoozed until ${new Date(when).toLocaleString()}`)
    })
    .catch(err => {
      console.error('Error snoozing tab:', err)
      showNotification('Failed to snooze tab')
    })
}

// Snooze until tomorrow 9AM
function snoozeTomorrowAt9AM(tab) {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)

  const alarmName = `snooze-${Date.now()}`

  chrome.storage.local
    .set({
      [alarmName]: {
        url: tab.url,
        title: tab.title,
        timestamp: Date.now(),
        scheduledFor: tomorrow.getTime(),
        recurring: false,
      },
    })
    .then(() => {
      // Use delayInMinutes for better persistence
      const delayMs = tomorrow.getTime() - Date.now()
      return chrome.alarms.create(alarmName, { delayInMinutes: delayMs / (1000 * 60) })
    })
    .then(() => {
      return chrome.tabs.remove(tab.id)
    })
    .then(() => {
      showNotification(`Tab snoozed until tomorrow at 9:00 AM`)
    })
    .catch(err => {
      console.error('Error snoozing tab until tomorrow:', err)
      showNotification('Failed to snooze tab')
    })
}

// Snooze until next Monday 9AM
function snoozeNextMonday(tab) {
  const nextMonday = new Date()
  const currentDay = nextMonday.getDay()

  // Calculate days until next Monday (1 = Monday, 0 = Sunday)
  // If today is Monday, schedule for next Monday (7 days)
  let daysUntilMonday = (1 - currentDay + 7) % 7
  if (daysUntilMonday === 0) {
    daysUntilMonday = 7 // If today is Monday, schedule for next Monday
  }

  nextMonday.setDate(nextMonday.getDate() + daysUntilMonday)
  nextMonday.setHours(9, 0, 0, 0)

  const alarmName = `snooze-${Date.now()}`

  chrome.storage.local
    .set({
      [alarmName]: {
        url: tab.url,
        title: tab.title,
        timestamp: Date.now(),
        scheduledFor: nextMonday.getTime(),
        recurring: false,
      },
    })
    .then(() => {
      // Use delayInMinutes for better persistence
      const delayMs = nextMonday.getTime() - Date.now()
      return chrome.alarms.create(alarmName, { delayInMinutes: delayMs / (1000 * 60) })
    })
    .then(() => {
      return chrome.tabs.remove(tab.id)
    })
    .then(() => {
      showNotification(`Tab snoozed until next Monday at 9:00 AM`)
    })
    .catch(err => {
      console.error('Error snoozing tab until next Monday:', err)
      showNotification('Failed to snooze tab')
    })
}

// Schedule custom snooze
function scheduleCustomSnooze(tab, targetDate) {
  const alarmName = `snooze-${Date.now()}`

  chrome.storage.local
    .set({
      [alarmName]: {
        url: tab.url,
        title: tab.title,
        timestamp: Date.now(),
        scheduledFor: targetDate.getTime(),
        recurring: false,
      },
    })
    .then(() => {
      // Use delayInMinutes for better persistence
      const delayMs = targetDate.getTime() - Date.now()
      return chrome.alarms.create(alarmName, { delayInMinutes: delayMs / (1000 * 60) })
    })
    .then(() => {
      return chrome.tabs.remove(tab.id)
    })
    .then(() => {
      showNotification(`Tab snoozed until ${targetDate.toLocaleString()}`)
    })
    .catch(err => {
      console.error('Error scheduling custom snooze:', err)
      showNotification('Failed to snooze tab')
    })
}

// Schedule recurring snooze
function scheduleRecurringSnooze(tabData) {
  const alarmName = `snooze-${Date.now()}`
  let nextDate = new Date()

  switch (tabData.recurringType) {
    case 'daily':
      nextDate.setDate(nextDate.getDate() + 1)
      break
    case 'weekly':
      if (tabData.selectedDays && tabData.selectedDays.length > 0) {
        // Find the next occurrence of any selected day
        const currentDay = nextDate.getDay()
        let daysToAdd = 1

        // Check if any selected day is today or in the next 6 days
        for (let i = 1; i <= 7; i++) {
          const checkDay = (currentDay + i) % 7
          if (tabData.selectedDays.includes(checkDay)) {
            daysToAdd = i
            break
          }
        }
        nextDate.setDate(nextDate.getDate() + daysToAdd)
      } else {
        // Fallback to next week same day
        nextDate.setDate(nextDate.getDate() + 7)
      }
      break
    case 'monthly':
      nextDate.setMonth(nextDate.getMonth() + 1)
      break
    case 'yearly':
      nextDate.setFullYear(nextDate.getFullYear() + 1)
      break
  }

  if (tabData.recurringTime) {
    const [hours, minutes] = tabData.recurringTime.split(':')
    nextDate.setHours(parseInt(hours), parseInt(minutes), 0, 0)
  }

  chrome.storage.local
    .set({
      [alarmName]: {
        ...tabData,
        scheduledFor: nextDate.getTime(),
      },
    })
    .then(() => {
      // Use delayInMinutes for better persistence
      const delayMs = nextDate.getTime() - Date.now()
      return chrome.alarms.create(alarmName, { delayInMinutes: delayMs / (1000 * 60) })
    })
    .catch(err => {
      console.error('Error scheduling recurring snooze:', err)
    })
}

// Show notification
function showNotification(message) {
  chrome.notifications?.create(
    {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon128.png'),
      title: 'Snooze Tabby',
      message: message,
    },
    () => {
      if (chrome.runtime.lastError) {
        console.error('Notification error:', chrome.runtime.lastError.message)
      }
    }
  )
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'snooze') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) {
        switch (request.type) {
          case '4-hours':
            snoozeTab(tabs[0], 4 * 60 * 60 * 1000)
            break
          case 'tomorrow-9am':
            snoozeTomorrowAt9AM(tabs[0])
            break
          case 'one-month':
            snoozeTab(tabs[0], 30 * 24 * 60 * 60 * 1000)
            break
          case 'next-monday':
            snoozeNextMonday(tabs[0])
            break
        }
      }
    })
  } else if (request.action === 'snoozeTab') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) {
        if (request.type === 'custom') {
          scheduleCustomSnooze(tabs[0], new Date(request.date))
        } else if (request.type === 'recurring') {
          scheduleRecurringTab(tabs[0], request.recurringType, request.recurringTime, request.selectedDays)
        }
      }
    })
  }
})

// Schedule recurring tab
function scheduleRecurringTab(tab, recurringType, recurringTime, selectedDays = []) {
  const alarmName = `snooze-${Date.now()}`
  let nextDate = new Date()

  switch (recurringType) {
    case 'daily':
      nextDate.setDate(nextDate.getDate() + 1)
      break
    case 'weekly':
      if (selectedDays.length > 0) {
        // Find the next occurrence of any selected day
        const currentDay = nextDate.getDay()
        let daysToAdd = 1

        // Check if any selected day is today or in the next 6 days
        for (let i = 1; i <= 7; i++) {
          const checkDay = (currentDay + i) % 7
          if (selectedDays.includes(checkDay)) {
            daysToAdd = i
            break
          }
        }
        nextDate.setDate(nextDate.getDate() + daysToAdd)
      } else {
        // Fallback to next week same day
        nextDate.setDate(nextDate.getDate() + 7)
      }
      break
    case 'monthly':
      nextDate.setMonth(nextDate.getMonth() + 1)
      break
    case 'yearly':
      nextDate.setFullYear(nextDate.getFullYear() + 1)
      break
  }

  if (recurringTime) {
    const [hours, minutes] = recurringTime.split(':')
    nextDate.setHours(parseInt(hours), parseInt(minutes), 0, 0)
  }

  chrome.storage.local
    .set({
      [alarmName]: {
        url: tab.url,
        title: tab.title,
        timestamp: Date.now(),
        scheduledFor: nextDate.getTime(),
        recurring: true,
        recurringType: recurringType,
        recurringTime: recurringTime,
        selectedDays: selectedDays,
      },
    })
    .then(() => {
      // Use delayInMinutes for better persistence
      const delayMs = nextDate.getTime() - Date.now()
      return chrome.alarms.create(alarmName, { delayInMinutes: delayMs / (1000 * 60) })
    })
    .then(() => {
      return chrome.tabs.remove(tab.id)
    })
    .then(() => {
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      const selectedDayNames = selectedDays
        .map(day => dayNames[day])
        .sort((a, b) => {
          const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
          return order.indexOf(a) - order.indexOf(b)
        })
        .join(', ')
      const message =
        recurringType === 'weekly'
          ? `Tab set to recur weekly on ${selectedDayNames} at ${recurringTime || 'current time'}`
          : `Tab set to recur ${recurringType} at ${recurringTime || 'current time'}`
      showNotification(message)
    })
    .catch(err => {
      console.error('Error scheduling recurring tab:', err)
      showNotification('Failed to schedule recurring tab')
    })
}
