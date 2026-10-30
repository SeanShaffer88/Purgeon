// Start with Windows (off unless you turn it on), using a current-user Limited
// scheduled task at sign-in. Existing older Highest tasks may need administrator
// assistance to migrate; their successful downgrade is not assumed. The
// task itself is the setting: on means the task exists. Turning it off deletes exactly that task.
import { sys } from './sys.js';
import { runPS, psq } from './shell.js';

const TASK_PATH = '\\Purgeon\\';
const TASK_NAME = 'Start at Sign-in';
// Where versions from before the rename put the task. It would start the old program, so it is
// removed whenever this option changes.
const OLD_TASK_PATH = '\\SweepUninstall\\';
const removeOld = () => runPS(`Unregister-ScheduledTask -TaskPath ${psq(OLD_TASK_PATH)} -TaskName ${psq(TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`).catch(() => {});

export async function enabled() {
  const out = await runPS(`[bool](Get-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME)} -ErrorAction SilentlyContinue)`).catch(() => 'False');
  return /True/i.test(out);
}

export async function set(on) {
  await removeOld();
  if (!on) {
    await runPS(`Unregister-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`).catch(() => {});
    return enabled();
  }
  await runPS(`
    $ErrorActionPreference = 'Stop'
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute ${psq(sys.info.exe)} -Argument '--started-by-windows'
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $trigger.Delay = 'PT20S'
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Starts Purgeon when you sign in (View › Start with Windows). Delete this task or turn the option off to stop it.' -Force | Out-Null`);
  // Report registration failure instead of quietly leaving the option off.
  if (!(await enabled())) throw new Error('Windows did not create the sign-in task. Windows refused to create the current-user sign-in task.');
  return true;
}
