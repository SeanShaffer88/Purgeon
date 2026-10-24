// Safe, reversible Windows debloat tweaks. Each tweak is a set of registry values:
// "enabled" means every value holds its tweak value; disabling restores Windows' default
// (deleting the value, or writing the documented default where one exists).
// effect: 'immediate' | 'explorer' (needs an Explorer restart) | 'reboot'
const { reg, runPS, runPSJson } = require('./shell.cjs');

const ADV = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced';
const CDM = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager';
const WU = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate';
const CLASSIC_MENU = 'HKCU\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}';

const dword = (key, name, on, off = null) => ({ key, name, type: 'REG_DWORD', on, off });

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

async function set(id, enable) {
  const t = TWEAKS.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown tweak ${id}`);
  for (const v of t.values) {
    let r;
    if (enable) {
      r = await reg(['add', v.key, ...(v.name ? ['/v', v.name] : ['/ve']), '/t', v.type, '/d', String(v.on), '/f']);
    } else if (v.deleteKeyOnRevert) {
      r = await reg(['delete', v.deleteKeyOnRevert, '/f']);
    } else if (v.off === null) {
      r = await reg(['delete', v.key, '/v', v.name, '/f']);
      if (!r.ok && /unable to find/i.test(r.stderr)) r = { ok: true };
    } else {
      r = await reg(['add', v.key, '/v', v.name, '/t', v.type, '/d', String(v.off), '/f']);
    }
    if (!r.ok) {
      const denied = /access is denied/i.test(r.stderr);
      throw new Error(denied ? `"${t.title}" needs administrator rights. Use File › Restart as Administrator.` : r.stderr.trim());
    }
  }
}

async function restartExplorer() {
  await runPS(`
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 1500
    if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
  `);
}

module.exports = { list, set, restartExplorer, TWEAKS, needsAdmin };
