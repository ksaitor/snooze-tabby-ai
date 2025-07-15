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

// Handle alarm triggers
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name.startsWith('snooze-')) {
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

// Snooze tab function
function snoozeTab(tab, delayMs) {
  const alarmName = `snooze-${Date.now()}`
  const when = Date.now() + delayMs

  // Store tab data
  chrome.storage.local.set({
    [alarmName]: {
      url: tab.url,
      title: tab.title,
      timestamp: Date.now(),
      scheduledFor: when,
      recurring: false,
    },
  })

  // Create alarm
  chrome.alarms.create(alarmName, { when })

  // Close the tab
  chrome.tabs.remove(tab.id)

  // Show notification
  showNotification(`Tab snoozed until ${new Date(when).toLocaleString()}`)
}

// Snooze until tomorrow 9AM
function snoozeTomorrowAt9AM(tab) {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)

  const alarmName = `snooze-${Date.now()}`

  chrome.storage.local.set({
    [alarmName]: {
      url: tab.url,
      title: tab.title,
      timestamp: Date.now(),
      scheduledFor: tomorrow.getTime(),
      recurring: false,
    },
  })

  chrome.alarms.create(alarmName, { when: tomorrow.getTime() })
  chrome.tabs.remove(tab.id)

  showNotification(`Tab snoozed until tomorrow at 9:00 AM`)
}

// Schedule custom snooze
function scheduleCustomSnooze(tab, targetDate) {
  const alarmName = `snooze-${Date.now()}`

  chrome.storage.local.set({
    [alarmName]: {
      url: tab.url,
      title: tab.title,
      timestamp: Date.now(),
      scheduledFor: targetDate.getTime(),
      recurring: false,
    },
  })

  chrome.alarms.create(alarmName, { when: targetDate.getTime() })
  chrome.tabs.remove(tab.id)

  showNotification(`Tab snoozed until ${targetDate.toLocaleString()}`)
}

// Schedule recurring snooze
function scheduleRecurringSnooze(tabData) {
  const alarmName = `snooze-${Date.now()}`
  let nextDate = new Date()

  switch (tabData.recurringType) {
    case 'daily':
      nextDate.setDate(nextDate.getDate() + 1)
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

  chrome.storage.local.set({
    [alarmName]: {
      ...tabData,
      scheduledFor: nextDate.getTime(),
    },
  })

  chrome.alarms.create(alarmName, { when: nextDate.getTime() })
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
          scheduleRecurringTab(tabs[0], request.recurringType, request.recurringTime)
        }
      }
    })
  }
})

// Schedule recurring tab
function scheduleRecurringTab(tab, recurringType, recurringTime) {
  const alarmName = `snooze-${Date.now()}`
  let nextDate = new Date()

  switch (recurringType) {
    case 'daily':
      nextDate.setDate(nextDate.getDate() + 1)
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

  chrome.storage.local.set({
    [alarmName]: {
      url: tab.url,
      title: tab.title,
      timestamp: Date.now(),
      scheduledFor: nextDate.getTime(),
      recurring: true,
      recurringType: recurringType,
      recurringTime: recurringTime,
    },
  })

  chrome.alarms.create(alarmName, { when: nextDate.getTime() })
  chrome.tabs.remove(tab.id)

  showNotification(`Tab set to recur ${recurringType} at ${recurringTime || 'current time'}`)
}
