// Safe, reversible Windows debloat tweaks. Each tweak is a set of registry values:
// "enabled" means every value holds its tweak value. Disabling puts back what was there before
// Purgeon applied the tweak; if that is unknown, it restores Windows' default.
// effect: 'immediate' | 'explorer' (needs an Explorer restart) | 'reboot'
import { sys } from './sys.js';
import * as path from './winpath.js';
import { reg, runPS, runPSJson } from './shell.js';

const ADV = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced';
const CDM = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager';
const WU = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate';
const CLASSIC_MENU = 'HKCU\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}';

const dword = (key, name, on, off = null) => ({ key, name, type: 'REG_DWORD', on, off });

// App Privacy toggles all use the same per-user store the Settings app writes:
// one string value per capability, "Deny" blocks apps, "Allow" is the default.
const CONSENT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore';
const consent = (capability) => ({ key: `${CONSENT}\\${capability}`, name: 'Value', type: 'REG_SZ', on: 'Deny', off: 'Allow' });
const SETTING_SYNC = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\SettingSync';

const TWEAKS = [
  // Privacy & telemetry
  { id: 'adid', category: 'Privacy & telemetry', title: 'Disable advertising ID', detail: 'Apps can no longer use your advertising ID to show personalized ads.', effect: 'immediate', values: [dword('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo', 'Enabled', 0, 1)] },
  { id: 'tailored', category: 'Privacy & telemetry', title: 'Disable tailored experiences', detail: 'Microsoft stops using diagnostic data to personalize tips, ads and recommendations.', effect: 'immediate', values: [dword('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Privacy', 'TailoredExperiencesWithDiagnosticDataEnabled', 0, 1)] },
  { id: 'langlist', category: 'Privacy & telemetry', title: "Don't share language list with websites", detail: 'Websites can no longer read your installed languages to tailor content.', effect: 'immediate', values: [dword('HKCU\\Control Panel\\International\\User Profile', 'HttpAcceptLanguageOptOut', 1)] },
  { id: 'feedback', category: 'Privacy & telemetry', title: 'Stop feedback prompts', detail: 'Windows no longer pops up requests to rate or give feedback.', effect: 'immediate', values: [dword('HKCU\\Software\\Microsoft\\Siuf\\Rules', 'NumberOfSIUFInPeriod', 0)] },
  { id: 'tracklaunch', category: 'Privacy & telemetry', title: 'Disable app launch tracking', detail: 'Windows stops tracking which apps you open to rank Start and search results.', effect: 'explorer', values: [dword(ADV, 'Start_TrackProgs', 0, 1)] },
  { id: 'activity', category: 'Privacy & telemetry', title: 'Disable activity history', detail: 'Windows stops collecting and uploading the apps, files and sites you use.', effect: 'reboot', values: [dword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System', 'PublishUserActivities', 0), dword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System', 'UploadUserActivities', 0)] },
  { id: 'telemetry', category: 'Privacy & telemetry', title: 'Limit diagnostic data to required only', detail: 'Sends only the minimum diagnostic data Windows needs to stay secure and updated.', effect: 'reboot', values: [dword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection', 'AllowTelemetry', 1)] },

  // Start, search & taskbar
  { id: 'bing', category: 'Start, search & taskbar', title: 'Disable Bing web results in Start search', detail: 'Start search shows only local apps, files and settings.', effect: 'explorer', values: [dword('HKCU\\Software\\Policies\\Microsoft\\Windows\\Explorer', 'DisableSearchBoxSuggestions', 1)] },
  { id: 'startrec', category: 'Start, search & taskbar', title: 'Hide Start menu recommendations', detail: 'Removes promoted tips, shortcuts and new-app suggestions from Start.', effect: 'explorer', values: [dword(ADV, 'Start_IrisRecommendations', 0)] },
  { id: 'widgets', category: 'Start, search & taskbar', title: 'Disable Widgets and the news feed', detail: 'Removes the Widgets board and its taskbar button.', effect: 'explorer', values: [dword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Dsh', 'AllowNewsAndInterests', 0)] },
  { id: 'copilot', category: 'Start, search & taskbar', title: 'Hide Copilot taskbar button', detail: 'Removes the Copilot button from the taskbar. Copilot stays installed.', effect: 'immediate', values: [dword(ADV, 'ShowCopilotButton', 0)] },
  { id: 'taskview', category: 'Start, search & taskbar', title: 'Hide Task View taskbar button', detail: 'Removes the Task View button. Win+Tab still works.', effect: 'immediate', values: [dword(ADV, 'ShowTaskViewButton', 0)] },

  // Ads & suggestions
  { id: 'lockscreen', category: 'Ads & suggestions', title: 'Disable lock screen tips and fun facts', detail: 'Removes ads, tips and trivia from the lock screen.', effect: 'immediate', values: [dword(CDM, 'RotatingLockScreenOverlayEnabled', 0), dword(CDM, 'SubscribedContent-338387Enabled', 0)] },
  { id: 'settingsads', category: 'Ads & suggestions', title: 'Disable suggestions in Settings', detail: 'Removes suggested content and promotions from the Settings app.', effect: 'immediate', values: [dword(CDM, 'SubscribedContent-338393Enabled', 0), dword(CDM, 'SubscribedContent-353694Enabled', 0), dword(CDM, 'SubscribedContent-353696Enabled', 0)] },
  { id: 'tipsnotif', category: 'Ads & suggestions', title: 'Disable tips and suggestions notifications', detail: 'Stops "tips, tricks and suggestions" notifications.', effect: 'immediate', values: [dword(CDM, 'SubscribedContent-338389Enabled', 0), dword(CDM, 'SoftLandingEnabled', 0)] },
  { id: 'welcome', category: 'Ads & suggestions', title: 'Disable welcome experience after updates', detail: 'Skips the "what\'s new" screens shown after updates and sign-in.', effect: 'immediate', values: [dword(CDM, 'SubscribedContent-310093Enabled', 0)] },
  { id: 'scoobe', category: 'Ads & suggestions', title: 'Disable "Get even more out of Windows" nag', detail: 'Stops the full-screen setup reminder that pushes Microsoft services.', effect: 'immediate', values: [dword('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\UserProfileEngagement', 'ScoobeSystemSettingEnabled', 0)] },
  { id: 'silentapps', category: 'Ads & suggestions', title: 'Stop automatic installs of suggested apps', detail: 'Windows stops silently installing promoted apps and games. Already installed apps stay.', effect: 'immediate', values: [dword(CDM, 'SilentInstalledAppsEnabled', 0), dword(CDM, 'PreInstalledAppsEnabled', 0), dword(CDM, 'OemPreInstalledAppsEnabled', 0)] },

  // Explorer & UI
  { id: 'fileext', category: 'Explorer & UI', title: 'Show file extensions', detail: 'Shows extensions like .exe and .pdf, which makes disguised files easier to spot.', effect: 'explorer', values: [dword(ADV, 'HideFileExt', 0, 1)] },
  { id: 'classicmenu', category: 'Explorer & UI', title: 'Use the classic right-click menu', detail: 'Shows the full context menu right away instead of "Show more options".', effect: 'explorer', values: [{ key: `${CLASSIC_MENU}\\InprocServer32`, name: '', type: 'REG_SZ', on: '', deleteKeyOnRevert: CLASSIC_MENU }] },
  { id: 'syncads', category: 'Explorer & UI', title: 'Disable OneDrive ads in File Explorer', detail: 'Stops sync provider notifications and promotions inside Explorer.', effect: 'explorer', values: [dword(ADV, 'ShowSyncProviderNotifications', 0)] },
  { id: 'cloudquick', category: 'Explorer & UI', title: 'Hide Office.com files in Explorer Home', detail: 'Explorer Home shows only local files, not cloud files from Office.com.', effect: 'explorer', values: [dword('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer', 'ShowCloudFilesInQuickAccess', 0)] },

  // Windows Update
  { id: 'noautoreboot', category: 'Windows Update', title: "Don't auto-restart while signed in", detail: 'Windows waits for you to restart instead of rebooting on its own to finish updates.', effect: 'reboot', values: [dword(`${WU}\\AU`, 'NoAutoRebootWithLoggedOnUsers', 1)] },
  { id: 'nop2p', category: 'Windows Update', title: 'Disable peer-to-peer update sharing', detail: "Updates download only from Microsoft. Your PC doesn't upload updates to other PCs.", effect: 'reboot', values: [dword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DeliveryOptimization', 'DODownloadMode', 0)] },
  { id: 'nodrivers', category: 'Windows Update', title: 'Exclude drivers from Windows Update', detail: 'Windows Update stops replacing your drivers. Update GPU and other drivers yourself.', effect: 'reboot', values: [dword(WU, 'ExcludeWUDriversInQualityUpdate', 1)] },
  { id: 'notifydl', category: 'Windows Update', title: 'Notify before downloading updates', detail: 'Windows asks before downloading updates. Some editions, including Home, may ignore this.', effect: 'reboot', values: [dword(`${WU}\\AU`, 'NoAutoUpdate', 0), dword(`${WU}\\AU`, 'AUOptions', 2)] },

  // App Privacy: what Store apps may reach. Same store and values as Settings › Privacy.
  { id: 'appacctinfo', category: 'App Privacy', title: 'Disable app access to account info', detail: 'Apps can no longer read your name, picture and other account info.', effect: 'immediate', values: [consent('userAccountInformation')] },
  { id: 'appdiag', category: 'App Privacy', title: 'Disable app access to diagnostic info', detail: 'Apps can no longer read diagnostic data about your other apps.', effect: 'immediate', values: [consent('appDiagnostics')] },
  { id: 'appgenai', category: 'App Privacy', title: 'Disable app access to generative AI', detail: "Apps can no longer use Windows' built-in generative AI features.", effect: 'immediate', values: [consent('generativeAI')] },
  { id: 'apppresence', category: 'App Privacy', title: 'Disable app access to presence sensing', detail: 'Apps can no longer tell whether you are at the device.', effect: 'immediate', values: [consent('humanPresence')] },
  { id: 'applocation', category: 'App Privacy', title: 'Disable app access to location', detail: 'Apps can no longer read your location.', effect: 'immediate', values: [consent('location')] },
  { id: 'appcam', category: 'App Privacy', title: 'Disable app access to the camera', detail: 'Apps can no longer use your webcam.', effect: 'immediate', values: [consent('webcam')] },
  { id: 'appmic', category: 'App Privacy', title: 'Disable app access to the microphone', detail: 'Apps can no longer record audio.', effect: 'immediate', values: [consent('microphone')] },
  { id: 'appnotify', category: 'App Privacy', title: 'Disable app access to notifications', detail: 'Apps can no longer read your notifications.', effect: 'immediate', values: [consent('userNotificationListener')] },
  { id: 'appmotion', category: 'App Privacy', title: 'Disable app access to motion data', detail: 'Apps can no longer read the activity and movement sensor.', effect: 'immediate', values: [consent('activity')] },
  { id: 'appcontacts', category: 'App Privacy', title: 'Disable app access to contacts', detail: 'Apps can no longer read your contacts.', effect: 'immediate', values: [consent('contacts')] },
  { id: 'appcalendar', category: 'App Privacy', title: 'Disable app access to the calendar', detail: 'Apps can no longer read or add appointments.', effect: 'immediate', values: [consent('appointments')] },
  { id: 'appcalls', category: 'App Privacy', title: 'Disable app access to phone calls', detail: 'Apps can no longer make or manage phone calls.', effect: 'immediate', values: [consent('phoneCall')] },
  { id: 'appcallhist', category: 'App Privacy', title: 'Disable app access to call history', detail: 'Apps can no longer read your call history.', effect: 'immediate', values: [consent('phoneCallHistory')] },
  { id: 'appemail', category: 'App Privacy', title: 'Disable app access to email', detail: 'Apps can no longer read or send email.', effect: 'immediate', values: [consent('email')] },
  { id: 'apptasks', category: 'App Privacy', title: 'Disable app access to tasks', detail: 'Apps can no longer read or edit your task lists.', effect: 'immediate', values: [consent('userDataTasks')] },
  { id: 'appmessages', category: 'App Privacy', title: 'Disable app access to messages', detail: 'Apps can no longer read or send text messages.', effect: 'immediate', values: [consent('chat')] },
  { id: 'appradios', category: 'App Privacy', title: 'Disable app control of radios', detail: 'Apps can no longer switch Wi-Fi, Bluetooth and other radios on or off.', effect: 'immediate', values: [consent('radios')] },
  { id: 'appdevicesync', category: 'App Privacy', title: 'Disable app sync with unpaired devices', detail: 'Apps can no longer share and sync info with wireless devices that are not explicitly paired.', effect: 'immediate', values: [consent('bluetoothSync')] },
  { id: 'appdocs', category: 'App Privacy', title: 'Disable app access to Documents', detail: 'Apps can no longer open your Documents folder on their own.', effect: 'immediate', values: [consent('documentsLibrary')] },
  { id: 'apppics', category: 'App Privacy', title: 'Disable app access to Pictures', detail: 'Apps can no longer open your Pictures folder on their own.', effect: 'immediate', values: [consent('picturesLibrary')] },
  { id: 'appvids', category: 'App Privacy', title: 'Disable app access to Videos', detail: 'Apps can no longer open your Videos folder on their own.', effect: 'immediate', values: [consent('videosLibrary')] },
  { id: 'appmusic', category: 'App Privacy', title: 'Disable app access to Music', detail: 'Apps can no longer open your Music folder on their own.', effect: 'immediate', values: [consent('musicLibrary')] },
  { id: 'appfiles', category: 'App Privacy', title: 'Disable app access to the file system', detail: 'Apps can no longer browse your whole file system on their own.', effect: 'immediate', values: [consent('broadFileSystemAccess')] },
  { id: 'apppasskeys', category: 'App Privacy', title: 'Disable app access to passkeys', detail: 'Apps can no longer create or use passkeys.', effect: 'immediate', values: [consent('passkeys')] },
  { id: 'appbt', category: 'App Privacy', title: 'Disable app access to Bluetooth', detail: 'Apps can no longer use Bluetooth.', effect: 'immediate', values: [consent('bluetooth')] },
  { id: 'appgaze', category: 'App Privacy', title: 'Disable app access to eye tracking', detail: 'Apps can no longer read where you look.', effect: 'immediate', values: [consent('gazeInput')] },
  { id: 'appcapture', category: 'App Privacy', title: 'Disable app screenshots', detail: 'Apps can no longer capture screenshots on their own.', effect: 'immediate', values: [consent('graphicsCaptureProgrammatic')] },
  { id: 'appcaptureborder', category: 'App Privacy', title: 'Disable borderless app screenshots', detail: 'Apps can no longer capture screenshots without a border.', effect: 'immediate', values: [consent('graphicsCaptureWithoutBorder')] },
  { id: 'apphid', category: 'App Privacy', title: 'Disable app access to human interface devices', detail: 'Apps can no longer use custom devices such as controllers and sensors.', effect: 'immediate', values: [consent('humanInterfaceDevice')] },
  { id: 'appbg', category: 'App Privacy', title: 'Disable background apps', detail: 'Apps no longer run in the background.', effect: 'immediate', values: [dword('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications', 'GlobalUserDisabled', 1, 0)] },
  { id: 'appvoice', category: 'App Privacy', title: 'Disable voice activation by apps', detail: 'Apps can no longer wake up and listen for voice commands.', effect: 'immediate', values: [dword('HKCU\\Software\\Microsoft\\Speech_OneCore\\Settings\\VoiceActivation\\UserPreferenceForAllApps', 'AgentActivationEnabled', 0, 1)] },
  { id: 'appvoicelock', category: 'App Privacy', title: 'Disable voice activation while locked', detail: 'Apps can no longer use voice activation from the lock screen.', effect: 'immediate', values: [dword('HKCU\\Software\\Microsoft\\Speech_OneCore\\Settings\\VoiceActivation\\UserPreferenceForAllApps', 'AgentActivationOnLockScreenEnabled', 0, 1)] },

  // More privacy
  { id: 'typinginfo', category: 'Privacy & telemetry', title: 'Disable transmission of typing information', detail: 'Windows stops sending information about how you type to Microsoft.', effect: 'immediate', values: [dword('HKCU\\Software\\Microsoft\\Input\\TIPC', 'Enabled', 0)] },
  { id: 'inputperson', category: 'Privacy & telemetry', title: 'Disable input personalization', detail: 'Windows stops collecting your typing and inking to personalize dictionaries and recognition.', effect: 'immediate', values: [dword('HKCU\\Software\\Microsoft\\InputPersonalization', 'RestrictImplicitTextCollection', 1), dword('HKCU\\Software\\Microsoft\\InputPersonalization', 'RestrictImplicitInkCollection', 1), dword('HKCU\\Software\\Microsoft\\InputPersonalization\\TrainedDataStore', 'HarvestContacts', 0)] },
  { id: 'onlinespeech', category: 'Privacy & telemetry', title: 'Disable online speech recognition', detail: "Voice dictation stops sending your speech to Microsoft's online recognition service.", effect: 'immediate', values: [dword('HKCU\\Software\\Microsoft\\Speech_OneCore\\Settings\\OnlineSpeechPrivacy', 'HasAccepted', 0)] },
  { id: 'clipboardhist', category: 'Privacy & telemetry', title: 'Disable clipboard history storage', detail: 'Windows no longer keeps a history of what you copy.', effect: 'immediate', values: [dword('HKCU\\Software\\Microsoft\\Clipboard', 'EnableClipboardHistory', 0)] },
  { id: 'toastnotif', category: 'Privacy & telemetry', title: 'Disable app notifications', detail: 'Apps no longer show toast notifications.', effect: 'immediate', values: [dword('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications', 'ToastEnabled', 0, 1)] },
  { id: 'cortana', category: 'Privacy & telemetry', title: 'Disable Cortana', detail: 'Cortana is turned off by policy.', effect: 'reboot', values: [dword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search', 'AllowCortana', 0), dword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search', 'CortanaConsent', 0)] },
  { id: 'findmydevice', category: 'Privacy & telemetry', title: 'Disable Find My Device', detail: "Windows stops reporting this device's location for the Find My Device service.", effect: 'reboot', values: [dword('HKLM\\SOFTWARE\\Policies\\Microsoft\\FindMyDevice', 'AllowFindMyDevice', 0)] },
  { id: 'locservices', category: 'Privacy & telemetry', title: 'Turn off location services device-wide', detail: 'The whole device location platform is off, for all apps and users. Stronger than the per-app location toggle.', effect: 'reboot', values: [dword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\LocationAndSensors', 'DisableLocation', 1)] },

  // More ads & suggestions
  { id: 'timelinesugg', category: 'Ads & suggestions', title: 'Disable suggestions in Timeline', detail: 'Timeline (Task View history) no longer shows suggested content.', effect: 'immediate', values: [dword(CDM, 'SubscribedContent-353698Enabled', 0, 1)] },
  { id: 'startsugg', category: 'Ads & suggestions', title: 'Disable suggestions in Start', detail: 'Start no longer occasionally shows suggestions for apps and content.', effect: 'explorer', values: [dword(CDM, 'SubscribedContent-338388Enabled', 0), dword(CDM, 'SystemPaneSuggestionsEnabled', 0)] },
  { id: 'settingsacctnotif', category: 'Ads & suggestions', title: 'Disable account notifications in Settings', detail: 'The Settings app stops showing Microsoft account notifications and prompts.', effect: 'immediate', values: [dword('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\SystemSettings\\AccountNotifications', 'EnableAccountNotifications', 0, 1)] },
  { id: 'spotlight', category: 'Ads & suggestions', title: 'Disable Windows Spotlight', detail: 'The lock screen stops downloading Spotlight wallpapers, facts and promotions from the internet.', effect: 'immediate', values: [dword('HKLM\\Software\\Policies\\Microsoft\\Windows\\CloudContent', 'DisableWindowsSpotlightFeatures', 1)] },
  { id: 'locknotif', category: 'Ads & suggestions', title: 'Disable notifications on the lock screen', detail: 'App notifications no longer appear on the lock screen.', effect: 'immediate', values: [dword('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings', 'NOC_GLOBAL_SETTING_ALLOW_TOASTS_ABOVE_LOCK', 0, 1)] },

  // More Start, search & taskbar
  { id: 'copilotfull', category: 'Start, search & taskbar', title: 'Disable Windows Copilot', detail: 'Copilot in Windows is turned off by policy, not just hidden from the taskbar.', effect: 'immediate', values: [dword('HKCU\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsCopilot', 'TurnOffWindowsCopilot', 1), dword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsCopilot', 'TurnOffWindowsCopilot', 1)] },
  { id: 'recall', category: 'Start, search & taskbar', title: 'Disable Recall snapshots', detail: 'Copilot+ PCs stop saving snapshots of your screen for Recall.', effect: 'reboot', values: [dword('HKCU\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsAI', 'DisableAIDataAnalysis', 1), dword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsAI', 'DisableAIDataAnalysis', 1)] },
  { id: 'searchmsa', category: 'Start, search & taskbar', title: 'Disable Microsoft account cloud content in search', detail: "Search no longer pulls results from your personal Microsoft account's cloud services.", effect: 'explorer', values: [dword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SearchSettings', 'IsMSACloudSearchEnabled', 0)] },
  { id: 'searchaad', category: 'Start, search & taskbar', title: 'Disable work or school cloud content in search', detail: 'Search no longer pulls results from your work or school account\'s cloud services.', effect: 'explorer', values: [dword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SearchSettings', 'IsAADCloudSearchEnabled', 0)] },
  { id: 'searchhistory', category: 'Start, search & taskbar', title: 'Disable device search history', detail: 'Windows stops storing and showing your previous searches.', effect: 'reboot', values: [dword('HKLM\\Software\\Policies\\Microsoft\\Windows\\Explorer', 'DisableSearchHistory', 1)] },
  { id: 'searchhighlights', category: 'Start, search & taskbar', title: 'Disable search highlights', detail: 'The search box stops showing daily highlights, pictures and suggested content.', effect: 'explorer', values: [dword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search', 'EnableDynamicContentInWSB', 0)] },
  { id: 'searchboxhide', category: 'Start, search & taskbar', title: 'Hide the search box on the taskbar', detail: 'Removes the search box from the taskbar. Search still works from Start.', effect: 'explorer', values: [dword('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Search', 'SearchboxTaskbarMode', 0)] },
  { id: 'chattaskbar', category: 'Start, search & taskbar', title: 'Hide the Chat taskbar icon', detail: 'Removes the Microsoft Teams Chat icon from the taskbar.', effect: 'explorer', values: [dword(ADV, 'TaskbarMn', 0, 1)] },
  { id: 'meetnow', category: 'Start, search & taskbar', title: 'Hide the "Meet now" taskbar icon', detail: 'Removes the Meet Now video-call icon from the taskbar corner.', effect: 'explorer', values: [dword('HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer', 'HideSCAMeetNow', 1)] },
  { id: 'phonelinkstart', category: 'Start, search & taskbar', title: 'Hide the mobile device panel in Start', detail: 'Start no longer shows the Phone Link mobile-device companion panel next to the menu.', effect: 'explorer', values: [dword('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Start\\Companions\\Microsoft.YourPhone_8wekyb3d8bbwe', 'IsEnabled', 0)] },

  // More Explorer & UI
  { id: 'jumplists', category: 'Explorer & UI', title: 'Disable recent items in Jump Lists', detail: 'Taskbar Jump Lists no longer show your recent and frequent documents.', effect: 'explorer', values: [dword(ADV, 'Start_TrackDocs', 0, 1)] },
  { id: 'spotlighticon', category: 'Explorer & UI', title: 'Hide the Spotlight desktop icon', detail: 'Removes the Windows Spotlight "learn about this picture" icon from the desktop.', effect: 'explorer', values: [dword('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\HideDesktopIcons\\NewStartPanel', '{2cc5ca98-6485-489a-920e-b3e88a6ccce3}', 1, 0)] },
  { id: 'endtask', category: 'Explorer & UI', title: 'Enable "End task" in the taskbar menu', detail: 'Lets you end a stuck app straight from its taskbar button\'s right-click menu.', effect: 'explorer', values: [dword('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced\\TaskbarDeveloperSettings', 'TaskbarEndTask', 1)] },
  { id: 'lastactiveclick', category: 'Explorer & UI', title: 'Switch to the last active window on taskbar click', detail: "Clicking a taskbar button jumps to the app's last used window instead of showing previews.", effect: 'explorer', values: [dword(ADV, 'LastActiveClick', 1, 0)] },
  { id: 'hidegallery', category: 'Explorer & UI', title: 'Hide Gallery from File Explorer', detail: "Removes the Gallery entry from Explorer's navigation pane.", effect: 'explorer', values: [dword('HKCU\\Software\\Classes\\CLSID\\{e88865ea-0e1c-4e20-9aa6-edcd0212c87c}', 'System.IsPinnedToNameSpaceTree', 0, 1)] },
  { id: 'hidesettingshome', category: 'Explorer & UI', title: 'Hide the Settings home page', detail: 'Settings opens without the promotional home page.', effect: 'immediate', values: [{ key: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer', name: 'SettingsPageVisibility', type: 'REG_SZ', on: 'hide:home', off: null }] },

  // Settings sync: the SettingSync policies are three-state; 2 with the user-override
  // companion at 1 is what "disabled" means there.
  { id: 'syncall', category: 'Settings sync', title: 'Disable synchronization of all Windows settings', detail: 'No settings of any kind roam to other devices with your account.', effect: 'reboot', values: [dword(SETTING_SYNC, 'DisableSettingSync', 2), dword(SETTING_SYNC, 'DisableSettingSyncUserOverride', 1)] },
  { id: 'syncdesign', category: 'Settings sync', title: 'Disable design settings synchronization', detail: 'Themes and desktop design no longer roam between devices.', effect: 'reboot', values: [dword(SETTING_SYNC, 'DisableDesktopThemeSettingSync', 2), dword(SETTING_SYNC, 'DisableDesktopThemeSettingSyncUserOverride', 1)] },
  { id: 'syncbrowser', category: 'Settings sync', title: 'Disable browser settings synchronization', detail: 'Browser settings no longer roam between devices.', effect: 'reboot', values: [dword(SETTING_SYNC, 'DisableWebBrowserSettingSync', 2), dword(SETTING_SYNC, 'DisableWebBrowserSettingSyncUserOverride', 1)] },
  { id: 'synccreds', category: 'Settings sync', title: 'Disable credential synchronization', detail: 'Saved passwords and credentials no longer roam between devices.', effect: 'reboot', values: [dword(SETTING_SYNC, 'DisableCredentialsSettingSync', 2), dword(SETTING_SYNC, 'DisableCredentialsSettingSyncUserOverride', 1), dword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SettingSync\\Groups\\Credentials', 'Enabled', 0, 1)] },
  { id: 'synclanguage', category: 'Settings sync', title: 'Disable language settings synchronization', detail: 'Language preferences no longer roam between devices.', effect: 'immediate', values: [dword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SettingSync\\Groups\\Language', 'Enabled', 0, 1)] },
  { id: 'syncadvanced', category: 'Settings sync', title: 'Disable "Other Windows settings" synchronization', detail: 'The remaining Windows settings no longer roam between devices.', effect: 'reboot', values: [dword(SETTING_SYNC, 'DisableWindowsSettingSync', 2), dword(SETTING_SYNC, 'DisableWindowsSettingSyncUserOverride', 1)] },
];

const needsAdmin = (t) => t.values.some((v) => /^HKLM\\|^HKCU\\Software\\Policies\\/i.test(v.key));

const READ = `
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$out = foreach ($v in $in) {
  $k = Get-Item -LiteralPath "Registry::$($v.key)" -ErrorAction SilentlyContinue
  $val = if ($k) { $k.GetValue($v.name, $null) } else { $null }
  [pscustomobject]@{ key = $v.key; name = $v.name; value = if ($null -eq $val) { $null } else { [string]$val } }
}
@($out) | ConvertTo-Json -Compress
`;

async function list() {
  const all = TWEAKS.flatMap((t) => t.values.map((v) => ({ key: v.key, name: v.name })));
  const current = await runPSJson(READ, { input: JSON.stringify(all) });
  const lookup = new Map(current.map((c) => [`${c.key}|${c.name}`.toLowerCase(), c.value]));
  return TWEAKS.map((t) => {
    const states = t.values.map((v) => lookup.get(`${v.key}|${v.name}`.toLowerCase()) === String(v.on));
    return {
      id: t.id,
      category: t.category,
      title: t.title,
      detail: t.detail,
      effect: t.effect,
      admin: needsAdmin(t),
      enabled: states.every(Boolean),
      partial: !states.every(Boolean) && states.some(Boolean),
    };
  });
}

// Values as they were before Purgeon first applied each tweak, so turning a tweak off
// puts back exactly what was there (not just the Windows default).
let stateFile = '';
const setRoot = async (dir) => {
  await sys.makeDir(dir);
  stateFile = path.join(dir, 'previous-values.json');
};
const readPrevious = () => sys.readText(stateFile).then(JSON.parse).catch(() => ({}));
const writePrevious = (s) => sys.writeText(stateFile, JSON.stringify(s, null, 2));

const REG_TYPE = { String: 'REG_SZ', ExpandString: 'REG_EXPAND_SZ', DWord: 'REG_DWORD', QWord: 'REG_QWORD', Binary: 'REG_BINARY', MultiString: 'REG_MULTI_SZ' };

const CAPTURE = `
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$out = foreach ($v in $in) {
  $k = Get-Item -LiteralPath "Registry::$($v.key)" -ErrorAction SilentlyContinue
  $keyExisted = [bool]$k
  $data = if ($k) { $k.GetValue($v.name, $null, 'DoNotExpandEnvironmentNames') } else { $null }
  $kind = if ($null -ne $data) { [string]$k.GetValueKind($v.name) } else { $null }
  if ($data -is [byte[]]) { $data = ($data | ForEach-Object { $_.ToString('x2') }) -join '' }
  elseif ($data -is [string[]]) { $data = $data -join '\\0' }
  [pscustomobject]@{ key = $v.key; name = $v.name; keyExisted = $keyExisted; existed = ($null -ne $data); kind = $kind; data = if ($null -ne $data) { [string]$data } else { $null } }
}
@($out) | ConvertTo-Json -Compress
`;

const fail = (t, r) => {
  const denied = /access is denied/i.test(r.stderr);
  throw new Error(denied ? `"${t.title}" needs administrator rights. Use File › Restart as Administrator.` : r.stderr.trim());
};
const valueArgs = (v) => (v.name ? ['/v', v.name] : ['/ve']);

async function set(id, enable) {
  const t = TWEAKS.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown tweak ${id}`);
  const previous = stateFile ? await readPrevious() : {};

  if (enable) {
    // Remember what was there the first time this tweak is applied.
    if (stateFile && !previous[id]) {
      previous[id] = await runPSJson(CAPTURE, { input: JSON.stringify(t.values.map((v) => ({ key: v.key, name: v.name }))) });
      await writePrevious(previous);
    }
    for (const v of t.values) {
      const r = await reg(['add', v.key, ...valueArgs(v), '/t', v.type, '/d', String(v.on), '/f']);
      if (!r.ok) fail(t, r);
    }
    return;
  }

  const saved = previous[id];
  for (const [i, v] of t.values.entries()) {
    const before = saved?.[i];
    let r;
    if (before && before.existed) {
      // Put back the exact earlier value.
      r = await reg(['add', v.key, ...valueArgs(v), '/t', REG_TYPE[before.kind] || v.type, '/d', before.data, '/f']);
    } else if (v.deleteKeyOnRevert && (!before || !before.keyExisted)) {
      r = await reg(['delete', v.deleteKeyOnRevert, '/f']);
      if (!r.ok && /unable to find/i.test(r.stderr)) r = { ok: true };
    } else if (before || v.off === null) {
      // It didn't exist before (or Windows' default is "absent"): remove it.
      r = await reg(['delete', v.key, ...(v.name ? ['/v', v.name] : ['/ve']), '/f']);
      if (!r.ok && /unable to find/i.test(r.stderr)) r = { ok: true };
    } else {
      r = await reg(['add', v.key, ...valueArgs(v), '/t', v.type, '/d', String(v.off), '/f']);
    }
    if (!r.ok) fail(t, r);
  }
  if (saved) {
    delete previous[id];
    await writePrevious(previous);
  }
}

async function restartExplorer() {
  await runPS(`
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 1500
    if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
  `);
}

export { setRoot, list, set, restartExplorer, TWEAKS, needsAdmin };
