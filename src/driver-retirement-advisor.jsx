import { useEffect, useId, useRef, useState } from 'react';
import { Dialog } from './core-dialog.jsx';
import { tx } from './backend/i18n.js';

const signatureLabels = ['Signature not reported', 'DISM reports unsigned', 'DISM reports signed'];
const unavailable = { status: 'unavailable', packages: [] };

function DeviceCounts({ counts }) {
  return <p>{tx('Present: {p0} · Not present: {p1} · Presence unknown: {p2}', { p0: counts.present, p1: counts.nonPresent, p2: counts.unknown })}</p>;
}

function PackageAdvice({ item, partial }) {
  const observed = item.bindings;
  const none = observed && !observed.present && !observed.nonPresent && !observed.unknown;
  return (
    <div className="driver-advisor-details">
      <p><b>{item.published}</b> · {item.provider} · {item.className} · {item.version}</p>
      <p>{tx(item.bootCritical ? 'Boot-critical flag reported' : 'No boot-critical flag reported')} · {tx(signatureLabels[item.signature])}</p>
      {!observed ? <p className="impact-note">{tx('Binding evidence unknown. Windows device data or a stable package identity was unavailable.')}</p>
        : none ? <p>{tx(partial ? 'No binding observed in the partial sample.' : 'No binding observed.')}</p>
          : <DeviceCounts counts={observed} />}
    </div>
  );
}

export function DriverRetirementAdvisorDialog({ onClose }) {
  const [view, setView] = useState({ status: 'idle', packages: [] });
  const [selected, setSelected] = useState('');
  const generation = useRef(0);
  const busy = useRef(false);
  const picker = useId();
  useEffect(() => () => { generation.current++; }, []);

  const close = () => {
    generation.current++;
    onClose();
  };
  const check = async () => {
    if (busy.current) return;
    busy.current = true;
    const serial = ++generation.current;
    setSelected('');
    setView({ status: 'loading', packages: [] });
    let report;
    try { report = await window.api.invoke('drivers:advisor'); }
    catch { report = unavailable; }
    if (serial !== generation.current) return;
    busy.current = false;
    setView(report);
    setSelected(report.packages[0]?.published || report.deviceBindings?.[0]?.inf || '');
  };
  const deviceOnly = view.status === 'deviceOnly';
  const rows = deviceOnly ? view.deviceBindings : view.packages;
  const item = rows.find((row) => (row.published || row.inf) === selected);
  const status = {
    idle: 'Check Windows for observed driver bindings.',
    loading: 'Checking Windows driver packages and devices…',
    complete: view.packages.length ? '{p0} packages observed.' : 'No third-party packages observed.',
    partial: view.packages.length ? 'Incomplete scan. {p0} packages shown from partial evidence.' : 'Incomplete scan. No package evidence is available.',
    deviceOnly: 'Package inventory unavailable. Purgeon must already be running as administrator to check it. Only device records were checked.',
    unavailable: 'Windows driver advice is unavailable. The Windows driver inventory requires Purgeon to already be running as administrator.',
  };
  return (
    <Dialog title={tx('Driver Retirement Advisor')} width={690} onClose={close} buttons={<>
      <button autoFocus onClick={check} aria-disabled={view.status === 'loading'}>{tx(view.status === 'idle' ? 'Check driver bindings' : 'Check again')}</button>
      <button onClick={close}>{tx('Close')}</button>
    </>}>
      <div className="driver-advisor">
        <p className="heading">{tx('Read-only observations from the Windows Driver Store and device records.')}</p>
        <p role="status" className="impact-note">{tx(status[view.status], { p0: view.packages.length })}</p>
        {deviceOnly && <p className="footnote">{tx(rows.length ? 'These INF names were reported by device records. The sample may be incomplete and cannot verify driver package identity.' : 'No OEM INF bindings were available in the device sample.')}</p>}
        {item && <>
          <label htmlFor={picker}>{tx(deviceOnly ? 'Observed device INF' : 'Driver package')}</label>
          <select id={picker} value={selected} onChange={(event) => setSelected(event.target.value)}>
            {rows.map((row) => <option key={row.published || row.inf} value={row.published || row.inf}>{deviceOnly ? row.inf : row.published + ' · ' + row.provider}</option>)}
          </select>
          {deviceOnly ? <DeviceCounts counts={item.counts} /> : <PackageAdvice item={item} partial={view.status === 'partial'} />}
        </>}
        <p className="footnote">{tx('Device bindings can change. No binding observed does not establish that a package is safe to remove.')}</p>
        {!deviceOnly && <p className="footnote">{tx('Recovery planning: confirm you have the vendor installer or a verified backup before making changes elsewhere. This check does not verify a backup.')}</p>}
      </div>
    </Dialog>
  );
}
