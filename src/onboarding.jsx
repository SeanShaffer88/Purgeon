import { tx } from './backend/i18n.js';
// Onboarding: welcome screen, first-run tips, and guided setup for new users.
// Everything is opt-in and can be revisited from Help › Welcome Back.
import { useState, useCallback } from 'react';
import { Dialog } from './core-dialog.jsx';

const api = window.api;

// ---- Welcome dialog: shown on first launch -----------------------------------

export function WelcomeDialog({ onClose, onGetStarted }) {
  const [step, setStep] = useState(1);
  const totalSteps = 3;

  const pages = [
    {
      title: 'Welcome to Purgeon',
      body: (
        <>
          <p>{tx("Purgeon helps you inspect installed programs and review what to remove.")}</p>
          <p>{tx("When you uninstall a program, Purgeon runs its uninstaller, then scans for what it left behind — files, registry keys, services, scheduled tasks — and lets you choose what to remove.")}</p>
          <p className="welcome-safe">
            <strong>{tx("Review the recovery plan first.")}</strong>{tx(" Cleanup keeps recovery records, but files require their Recycle Bin copies, and some actions cannot be undone.")}</p>
        </>
      ),
    },
    {
      title: 'What you can do',
      body: (
        <>
          <ul className="welcome-list">
            <li><strong>{tx("Uninstall programs:")}</strong>{tx(" Pick a program, click Uninstall, and review what Purgeon will remove before it happens.")}</li>
            <li><strong>{tx("Monitor installations:")}</strong>{tx(" Record what an installer creates, so you can remove it cleanly later (Tools › Monitor an Installation).")}</li>
            <li><strong>{tx("Clean up:")}</strong>{tx(" Remove temporary files, caches, and Windows clutter you don't need (Cleaner view).")}</li>
            <li><strong>{tx("Startup & services:")}</strong>{tx(" Turn off entries that start with Windows without deleting them (Startup & Services view).")}</li>
          </ul>
        </>
      ),
    },
    {
      title: 'Where to start',
      body: (
        <>
          <p>{tx("Pick where you'd like to go first:")}</p>
          <div className="welcome-paths">
            <button className="welcome-path primary" onClick={() => onGetStarted('programs')}>{tx("View my programs")}</button>
            <button className="welcome-path" onClick={() => onGetStarted('monitor')}>{tx("Monitor an installation")}</button>
            <button className="welcome-path" onClick={() => onGetStarted('junk')}>{tx("Clean up junk files")}</button>
          </div>
          <p className="welcome-hint">{tx("You can always reopen this from ")}<strong>{tx("Help › Welcome Back")}</strong>{tx(", and tips appear throughout the app to help you discover what Purgeon can do.")}</p>
        </>
      ),
    },
  ];

  const page = pages[step - 1];
  const isLast = step === totalSteps;

  return (
    <Dialog
      title={tx(page.title)}
      onClose={onClose}
      width={560}
      buttons={
        <>
          {step > 1 && (
            <button onClick={() => setStep(step - 1)}>{tx("Back")}</button>
          )}
          <button className="primary" autoFocus onClick={isLast ? () => onGetStarted('done') : () => setStep(step + 1)}>
            {isLast ? tx("Get Started") : tx("Next")}
          </button>
        </>
      }
    >
      <div className="welcome-page">
        <div className="welcome-progress">
          {[1, 2, 3].map((n) => (
            <span key={n} className={`step-dot ${n <= step ? 'on' : ''}`} aria-label={tx("Step {p0} of {p1}", { p0: (n), p1: (totalSteps) })} />
          ))}
          <span className="welcome-step-text" role="status" aria-live="polite">{tx("Step ")}{step}{tx(" of ")}{totalSteps}
          </span>
        </div>
        <p className="welcome-body">{tx(page.body)}</p>
      </div>
    </Dialog>
  );
}

// ---- First-run tips ----------------------------------------------------------

// Tips shown after the welcome, one at a time, dismissible.
// Each tip has a title, a short body, and an optional action the user can take.
export const FIRST_RUN_TIPS = [
  {
    id: 'find-anything',
    title: 'Find any command or program',
    body: (<>{tx("Press ")}<kbd>{tx("Ctrl+K")}</kbd>{tx(" to open the command palette. Type a program name or a command like \"uninstall\" and press Enter.")}</>),
    action: 'Try it now',
  },
  {
    id: 'right-click',
    title: 'Right-click a program for more',
    body: 'Right-click any program in the list to see actions like Uninstall, Analyze, Properties, and Hide From List.',
    action: 'Got it',
  },
  {
    id: 'backups',
    title: 'Review recovery options',
    body: 'Purgeon backs up every removal before it happens. You can undo any change from Change History, or restore individual items from Backups.',
    action: 'Got it',
  },
];

export function FirstRunTips({ visible, dismissed, onTipAction, onClose }) {
  // Controlled: the caller owns which tips are dismissed. (This component used to
  // keep its own dismissed set that nothing ever updated, so Dismiss, the X and
  // Escape all wrote into a void and the tip could never close.)
  const tip = FIRST_RUN_TIPS.find((t) => !dismissed?.has(t.id));
  if (!visible || !tip) {
    return null;
  }

  return (
    <Dialog
      title={tx("Tip: {p0}", { p0: (tip.title) })}
      onClose={onClose}
      width={520}
      buttons={
        <>
          <button onClick={() => onClose()}>{tx("Dismiss")}</button>
          {tip.action && (
            <button className="primary" autoFocus onClick={() => onTipAction(tip.id)}>
              {tip.action}
            </button>
          )}
        </>
      }
    >
      <p>{tip.body}</p>
    </Dialog>
  );
}

// ---- Keyboard shortcuts panel ------------------------------------------------

export const SHORTCUTS = [
  { group: 'Navigation', items: [
    ['Ctrl+1', 'Programs (installed desktop apps)'],
    ['Ctrl+2', 'Apps (Microsoft Store apps)'],
    ['Ctrl+3', 'Monitored Programs'],
    ['Ctrl+5', 'Debloat (Windows tweaks)'],
    ['Ctrl+6', 'Startup & Services'],
    ['Ctrl+7', 'Snapshots'],
    ['Ctrl+8', 'Cleaner (junk files)'],
    ['Ctrl+9', 'Uninstall Archive'],
    ['Ctrl+T', 'Change Timeline'],
    ['Ctrl+H', 'Change History'],
  ]},
  { group: 'Actions', items: [
    ['Ctrl+K', 'Command Palette (find any command or program)'],
    ['Del', 'Uninstall selected program'],
    ['Shift+Del', 'Force uninstall (broken uninstaller)'],
    ['Ctrl+L', 'Analyze Leftovers'],
    ['Ctrl+I', 'Analyze Program'],
    ['Ctrl+Q', 'Add to Uninstall Queue'],
    ['Ctrl+G', 'Set Group'],
    ['F5', 'Refresh the list'],
    ['Alt+Enter', 'Properties'],
  ]},
  { group: 'View', items: [
    ['Ctrl++', 'Zoom In'],
    ['Ctrl+-', 'Zoom Out'],
    ['Ctrl+0', 'Zoom Reset'],
    ['Ctrl+F', 'Find (focus search box)'],
    ['Ctrl+S', 'Export to HTML'],
    ['Ctrl+M', 'Monitor an Installation'],
    ['Ctrl+A', 'Select All visible rows'],
  ]},
];

export function ShortcutsDialog({ onClose }) {
  return (
    <Dialog
      title={tx("Keyboard Shortcuts")}
      onClose={onClose}
      width={560}
      buttons={
        <>
          <button className="primary" autoFocus onClick={onClose}>{tx("Close")}</button>
        </>
      }
    >
      <div className="shortcuts">
        {SHORTCUTS.map((g) => (
          <div key={g.group} className="shortcut-group">
            <div className="shortcut-group-title">{g.group}</div>
            <table className="shortcut-table">
              <tbody>
                {g.items.map(([key, label]) => (
                  <tr key={key}>
                    <td className="shortcut-key">{key}</td>
                    <td className="shortcut-label">{tx(label)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

// ---- User Guide --------------------------------------------------------------

export function UserGuide({ onClose }) {
  const sections = [
    {
      title: 'Uninstall a program',
      steps: [
        'Select the program in the Programs list.',
        'Click Uninstall (or press Del). Purgeon runs the program’s own uninstaller.',
        'Purgeon then scans for leftover files, registry keys, services and tasks.',
        'Choose what to remove and review the recovery plan. Registry exports and Recycle Bin copies may allow recovery; some actions cannot be undone.',
      ],
    },
    {
      title: 'Monitor an installation',
      steps: [
        'Choose Tools › Monitor an Installation and pick the installer.',
        'Purgeon takes a "before" snapshot, then you run the installer as usual.',
        'When setup is done, come back and click Installation Finished.',
        'Purgeon records everything the installer created, so you can remove it cleanly later.',
      ],
    },
    {
      title: 'Clean up junk files',
      steps: [
        'Open the Cleaner view (Ctrl+8).',
        'Tick the categories you want to clean (temporary files, caches, crash dumps).',
        'Click Clean Up Selected. Files go to the Recycle Bin, so you can get them back.',
      ],
    },
    {
      title: 'Turn off startup entries',
      steps: [
        'Open Startup & Services (Ctrl+6).',
        'Turn off entries you don’t want starting with Windows. Nothing is deleted.',
        'Turn them back on anytime from the same view.',
      ],
    },
  ];

  return (
    <Dialog
      title={tx("User Guide")}
      onClose={onClose}
      width={640}
      buttons={
        <>
          <button className="primary" autoFocus onClick={onClose}>{tx("Close")}</button>
        </>
      }
    >
      <div className="user-guide">
        {sections.map((s) => (
          <div key={s.title} className="guide-section">
            <div className="guide-title">{s.title}</div>
            <ol className="guide-steps">
              {s.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

// ---- What's New on update ----------------------------------------------------

export function UpdateAvailableDialog({ version, onClose, onDownload }) {
  return (
    <Dialog
      title={tx("What’s New")}
      onClose={onClose}
      width={560}
      buttons={
        <>
          <button onClick={onClose}>{tx("Not Now")}</button>
          <button className="primary" autoFocus onClick={onDownload}>{tx("Download v")}{version}</button>
        </>
      }
    >
      <p>{tx("A new version of Purgeon is available.")}</p>
      <p>{tx("Visit the Purgeon releases page to see what’s changed and download the installer.")}</p>
      <p className="footnote">{tx("Update checks are off by default and never nag after you dismiss them. Turn them on in Settings › Update Check.")}</p>
    </Dialog>
  );
}

// ---- Settings explanations ---------------------------------------------------

// Plain-language descriptions for each setting, shown in Settings dialogs.
export const SETTING_HELP = {
  createRestorePoints: {
    title: 'Create a restore point before changes',
    body: 'Before Purgeon uninstalls anything or applies a Windows tweak, it can create a Windows restore point. If anything goes wrong, you can roll the whole system back. Recommended: on.',
  },
  silentUninstall: {
    title: 'Run uninstallers silently',
    body: 'When on, uninstallers that support it (Windows Installer, Inno Setup, NSIS, WiX) run without showing their windows. Other uninstallers still show their window as usual.',
  },
  safeMode: {
    title: 'Safe Mode',
    body: 'When on, cleanup requires strong ownership evidence and excludes services, scheduled tasks, and firewall rules. Internal rule scores are selection rules, not measured probabilities. Review every proposed item.',
  },
  gridLines: {
    title: 'Show grid lines',
    body: 'Turns on the lines between rows and columns in the program list. Makes the list easier to read at a glance.',
  },
  theme: {
    title: 'Theme',
    body: 'Choose the dark terminal-style theme, a light theme, or high contrast (white on black with strong outlines).',
  },

  disabledConfirmations: {
    title: 'Skip confirmation prompts',
    body: 'Prompts you dismissed with "Don\'t show again" are listed here. You can restore any of them so they ask again before acting.',
  },
  backupMaxDays: {
    title: 'Keep backups for (days)',
    body: 'How long Purgeon keeps backups of removals before pruning them. 0 means keep forever. Each program\'s newest backup is always kept.',
  },
  backupMaxMB: {
    title: 'Backup storage limit (MB)',
    body: 'Maximum space Purgeon uses for backups. 0 means no limit. Old backups are removed first to stay under the limit.',
  },
  syncOn: {
    title: 'Settings sync',
    body: 'Keeps chosen programs\' settings the same on your PCs through a shared folder (for example in OneDrive). Settings being replaced go to the Recycle Bin first.',
  },
  toggleShell: {
    title: 'Explorer right-click menu',
    body: 'Adds "Uninstall with Purgeon" and "Who owns this?" to Explorer\'s right-click menu, for your user only.',
  },
  toggleSchedule: {
    title: 'Background monitoring',
    body: 'When on, Purgeon runs quietly while the PC is idle: scans for leftovers and watches for new startup entries. Results appear in Change History.',
  },
  toggleAutostart: {
    title: 'Start with Windows',
    body: 'Starts Purgeon when you sign in to Windows, through a scheduled task. Off by default.',
  },
  toggleDetect: {
    title: 'Detect installations',
    body: 'Watches for installers starting while Purgeon runs and asks whether to record them. Nothing is recorded unless you say yes.',
  },
};

export function SettingHelp({ key }) {
  const help = SETTING_HELP[key];
  if (!help) return null;
  return (
    <div className="setting-help">
      <strong>{tx(help.title)}</strong>{' '}
      <span>{tx(help.body)}</span>
    </div>
  );
}
