import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSections, saneTemp, uptimeText, memoryTypeName, sectionsToText } from '../src/backend/sysinfo.js';

const NOW = Date.parse('2026-10-27T12:00:00Z');

test('memory type codes map to plain names', () => {
  assert.equal(memoryTypeName(26), 'DDR4');
  assert.equal(memoryTypeName(34), 'DDR5');
  assert.equal(memoryTypeName(24), 'DDR3');
  assert.equal(memoryTypeName(0), '');
  assert.equal(memoryTypeName(undefined), '');
});

test('saneTemp keeps plausible readings and drops sensor fallbacks', () => {
  assert.equal(saneTemp(42.4), 42);
  assert.equal(saneTemp(115), 115);
  assert.equal(saneTemp(0), null);
  assert.equal(saneTemp(255), null);
  assert.equal(saneTemp(null), null);
  assert.equal(saneTemp('42'), null);
});

test('uptimeText phrases days, hours and minutes', () => {
  assert.equal(uptimeText('2026-10-24T08:00:00Z', NOW), 'Up 3 days, 4 hours');
  assert.equal(uptimeText('2026-10-27T06:30:00Z', NOW), 'Up 5 hours, 30 minutes');
  assert.equal(uptimeText('2026-10-27T11:15:00Z', NOW), 'Up 45 minutes');
  assert.equal(uptimeText('', NOW), '');
  assert.equal(uptimeText('2999-01-01T00:00:00Z', NOW), '');
});

const RAW = {
  os: { name: 'Microsoft Windows 11 Pro', arch: '64-bit', version: '24H2', build: '26100', installed: '2025-01-15T10:00:00Z', lastBoot: '2026-10-24T08:00:00Z', computer: 'SEAN-PC', user: 'SEAN-PC\\Sean' },
  cpu: { name: 'AMD Ryzen 7 7800X3D 8-Core Processor', cores: 8, threads: 16, mhz: 4200, tempC: 0 },
  ram: { totalBytes: 34293637120, slots: 4, modules: [
    { bytes: 17179869184, speed: 6000, type: 34, locator: 'DIMM 0', maker: 'G-Skill' },
    { bytes: 17179869184, speed: 6000, type: 34, locator: 'DIMM 1', maker: 'G-Skill' },
  ] },
  board: { maker: 'Micro-Star International Co., Ltd.', product: 'PRO B650-VC WIFI', version: '1.0' },
  gpus: [{ name: 'NVIDIA GeForce RTX 4070', driver: '32.0.15.1', ramBytes: 12884901888, h: 2560, v: 1440, refresh: 165 }],
  disks: [
    { model: 'WD Green SN3000 1TB', bytes: 1000204886016, iface: 'SCSI', bus: 'NVMe', media: 'SSD', tempC: 34 },
    { model: 'Seagate FireCuda HDD', bytes: 5000981077504, iface: 'USB', bus: 'USB', media: 'HDD', tempC: 300 },
  ],
  optical: [],
  audio: ['NVIDIA Virtual Audio Device (Wave Extensible) (WDM)'],
};

test('buildSections formats a full sweep like the reference layout', () => {
  const s = buildSections(RAW, NOW);
  const byTitle = Object.fromEntries(s.map((x) => [x.title, x.rows]));
  assert.equal(byTitle['Operating System'][0].head, 'Windows 11 Pro 64-bit');
  assert.equal(byTitle['Operating System'][1].head, 'Version 24H2 · build 26100');
  assert.equal(byTitle['Operating System'][2].head, 'Up 3 days, 4 hours');
  assert.equal(byTitle['CPU'][0].sub, '8 cores · 16 threads · up to 4.20 GHz');
  assert.equal(byTitle['CPU'][0].tempC, undefined, 'a 0-degree fallback reading is dropped');
  assert.equal(byTitle['RAM'][0].head, '32.0GB DDR5 @ 6000MHz');
  assert.equal(byTitle['RAM'][0].sub, '2 of 4 slots used');
  assert.equal(byTitle['Graphics'][0].sub, '12.0GB memory · 2560×1440 @ 165Hz · driver 32.0.15.1');
  assert.equal(byTitle['Storage'][0].head, '1000GB WD Green SN3000 1TB (NVMe · SSD)');
  assert.equal(byTitle['Storage'][0].tempC, 34);
  assert.equal(byTitle['Storage'][1].tempC, undefined, 'an absurd disk temperature is dropped');
  assert.equal(byTitle['Optical Drives'][0].head, 'No optical disk drives detected');
  assert.equal(byTitle['Audio'][0].head, 'NVIDIA Virtual Audio Device (Wave Extensible) (WDM)');
});

test('buildSections survives a failed sweep', () => {
  const s = buildSections(null, NOW);
  assert.equal(s.length, 1);
  assert.match(s[0].rows[0].head, /could not be read/);
});

test('sectionsToText renders titles, rows and temperatures', () => {
  const text = sectionsToText(buildSections(RAW, NOW));
  assert.match(text, /Storage\r\n  1000GB WD Green SN3000 1TB \(NVMe · SSD\)  34 °C/);
  assert.match(text, /Operating System\r\n  Windows 11 Pro 64-bit/);
});
