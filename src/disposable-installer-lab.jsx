import { useEffect, useId, useRef, useState } from 'react';
import { Dialog } from './core-dialog.jsx';
import { tx } from './backend/i18n.js';

export function DisposableInstallerLabDialog({ onClose }) {
  const [lab, setLab] = useState(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [observation, setObservation] = useState(null);
  const serial = useRef(0);
  const generationBusy = useRef(false);
  const codeId = useId();
  useEffect(() => () => { serial.current++; }, []);

  const close = () => {
    serial.current++;
    onClose();
  };
  const generate = async () => {
    if (generationBusy.current) return;
    generationBusy.current = true;
    const request = ++serial.current;
    setBusy(true);
    setStatus('Choose an installer and output folder. Preparing the files can take a moment.');
    try {
      const result = await window.api.invoke('installerLab:generate');
      if (request !== serial.current) return;
      if (result) {
        setLab(result);
        setCode('');
        setObservation(null);
      }
      setStatus(result ? 'Lab files ready. Windows Sandbox availability has not been checked.' : 'Selection cancelled.');
    } catch (error) {
      if (request === serial.current) setStatus(String(error?.message || error));
    } finally {
      generationBusy.current = false;
      if (request === serial.current) setBusy(false);
    }
  };
  const openFolder = async () => {
    if (generationBusy.current) return;
    const request = serial.current;
    try { await window.api.invoke('installerLab:openFolder', { id: lab.id }); }
    catch (error) { if (request === serial.current) setStatus(String(error?.message || error)); }
  };
  const readCode = async () => {
    if (generationBusy.current) return;
    const request = ++serial.current;
    setObservation(null);
    try {
      const result = await window.api.invoke('installerLab:readCode', { id: lab.id, code });
      if (request === serial.current) {
        setObservation(result);
        setStatus('');
      }
    } catch (error) {
      if (request === serial.current) setStatus(String(error?.message || error));
    }
  };
  const changeCode = event => {
    serial.current++;
    setCode(event.target.value);
    setObservation(null);
  };
  return (
    <Dialog title={tx('Disposable Installer Lab')} onClose={close} width={690} buttons={<>
      <button autoFocus disabled={busy} onClick={generate}>{tx('Generate lab…')}</button>
      <button onClick={close}>{tx('Close')}</button>
    </>}>
      <div className="installer-lab">
        <p className="heading">{tx('Prepare an offline Windows Sandbox lab for one local installer.')}</p>
        <p>{tx('Choose an EXE or MSI and where to create a new folder. Purgeon only prepares the files. Open Lab.wsb yourself, then follow Read me.txt and run the installer inside the guest.')}</p>
        {status && <p role="status" className="impact-note">{tx(status)}</p>}
        {lab && <>
          <p><b>{lab.installerName}</b></p>
          <p>{lab.folder}</p>
          <div className="lab-actions"><button disabled={busy} onClick={openFolder}>{tx('Open folder')}</button></div>
          <label htmlFor={codeId}>{tx('Type the report code from the guest')}</label>
          <input id={codeId} value={code} onChange={changeCode} disabled={busy} maxLength={64} autoComplete="off" spellCheck={false} />
          <div className="lab-actions"><button disabled={busy || !code.trim()} onClick={readCode}>{tx('Read code')}</button></div>
          {observation && <div role="status">
            <p>{tx(observation.coverage === 7 ? 'All three registration views covered.' : observation.coverage ? 'Partial coverage of guest registration views.' : 'No guest registration views covered.')}</p>
            <p>{tx('Added: {p0} · Missing: {p1} · Changed: {p2}', { p0: observation.added, p1: observation.missing, p2: observation.changed })}</p>
          </div>}
        </>}
        <p className="footnote">{tx('The code contains guest-provided counts only. It can be forged and cannot prove what the installer did. Purgeon does not apply the report to this PC.')}</p>
      </div>
    </Dialog>
  );
}
