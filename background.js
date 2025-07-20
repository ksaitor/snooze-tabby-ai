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
      }
    }
  })
})

// Handle startup - check for missed tabs when browser starts
chrome.runtime.onStartup.addListener(() => {
  checkForMissedTabs()
  ensurePeriodicCheck()
  cleanupOrphanedAlarms()
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
        // Reopen the tab
        chrome.tabs.create({
          url: tabData.url,
          active: true,
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
function checkForMissedTabs() {
  chrome.storage.local
    .get(null, data => {
      const now = Date.now()
      const missedTabs = []

      Object.keys(data).forEach(key => {
        if (key.startsWith('snooze-') && data[key].scheduledFor <= now) {
          missedTabs.push({ key, ...data[key] })
        }
      })

      if (missedTabs.length > 0) {
        console.log(`Found ${missedTabs.length} missed tabs, reopening...`)

        missedTabs.forEach(tabData => {
          try {
            // Validate tab data
            if (!tabData.url || !tabData.title) {
              console.warn('Invalid tab data, skipping:', tabData)
              chrome.storage.local.remove([tabData.key])
              return
            }

            // Open the missed tab
            chrome.tabs
              .create({
                url: tabData.url,
                active: false, // Don't make it active to avoid disrupting user
              })
              .catch(err => {
                console.error('Failed to open tab:', err)
                showNotification(`Failed to open tab: ${tabData.title}`)
              })

            // Handle recurring tabs
            if (tabData.recurring) {
              scheduleRecurringSnooze(tabData)
            } else {
              // Clean up storage
              chrome.storage.local.remove([tabData.key]).catch(err => {
                console.error('Failed to clean up storage:', err)
              })
            }
          } catch (err) {
            console.error('Error processing missed tab:', err)
          }
        })

        // Show notification about reopened tabs
        showNotification(`${missedTabs.length} tab(s) reopened from snooze`)
      }
    })
    .catch(err => {
      console.error('Error checking for missed tabs:', err)
    })
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
  chrome.notifications?.create({
    type: 'basic',
    title: 'Snooze Tabby',
    message: message,
  })
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
