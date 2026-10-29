// Scheduled Tasks: shaping, the Windows-task guard, and task XML building.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWindowsTask, taskGuard, shapeTasks, taskXml } from '../src/backend/tasks.js';

test('Windows tasks are the ones under the Microsoft folder', () => {
  assert.equal(isWindowsTask('\\Microsoft\\Windows\\UpdateOrchestrator\\'), true);
  assert.equal(isWindowsTask('\\'), false);
  assert.equal(isWindowsTask('\\Purgeon\\'), false);
  assert.ok(taskGuard({ path: '\\Microsoft\\Windows\\' }));
  assert.equal(taskGuard({ path: '\\' }), null);
});

test('tasks shape with run info merged by path and name', () => {
  const shaped = shapeTasks(
    [
      { TaskName: 'Purgeon Weekly Maintenance', TaskPath: '\\', State: 'Ready', Author: 'SEAN' },
      { TaskName: 'Scan', TaskPath: '\\Microsoft\\Windows\\Defender\\', State: 'Running', Author: '' },
    ],
    [
      { TaskName: 'Purgeon Weekly Maintenance', TaskPath: '\\', LastRunTime: '2026-10-26T10:00:00', NextRunTime: '2026-11-02T10:00:00', LastTaskResult: 0 },
    ],
  );
  assert.equal(shaped.length, 2);
  const own = shaped.find((t) => t.name.startsWith('Purgeon'));
  assert.equal(own.lastResult, 0);
  assert.equal(own.isWindows, false);
  const win = shaped.find((t) => t.name === 'Scan');
  assert.equal(win.isWindows, true);
  assert.equal(win.lastResult, null);
});

test('task XML carries the trigger the user picked, escaped safely', () => {
  const logon = taskXml({ name: 'Morning <check>', program: 'C:\\Tools\\a&b.exe', trigger: 'logon' });
  assert.match(logon, /<LogonTrigger>/);
  assert.match(logon, /Morning &lt;check&gt;/);
  assert.match(logon, /a&amp;b\.exe/);
  const weekly = taskXml({ name: 'W', program: 'x.exe', trigger: 'weekly', time: '07:30', day: 'Friday' });
  assert.match(weekly, /<Friday \/>/);
  assert.match(weekly, /T07:30:00/);
  const daily = taskXml({ name: 'D', program: 'x.exe', trigger: 'daily', time: '22:15' });
  assert.match(daily, /<ScheduleByDay>/);
  assert.match(daily, /T22:15:00/);
});
