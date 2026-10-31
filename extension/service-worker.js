chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  const openedPanel = chrome.sidePanel.open({ tabId: tab.id });
  const savedTab = chrome.storage.session.set({ invokedPhoneTabId: tab.id });
  try {
    await Promise.all([openedPanel, savedTab]);
  } catch (error) {
    console.error("Could not open the Uleadz Call Listener side panel.", error);
    throw error;
  }
});
