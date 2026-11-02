import { useEffect, useRef, useState } from 'react';
import { Dialog } from './core-dialog.jsx';
import { resolveLanguage, t } from './backend/i18n.js';

const api = window.api;

export function SettingsSyncDialog({ onClose, onApplied }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  useEffect(() => {
    let alive = true;
    api.invoke('sync:status').then((value) => { if (alive) setStatus(value); }).catch((reason) => { if (alive) setError(reason.message); });
    return () => { alive = false; };
  }, []);
  const run = async (direction) => {
    if (running.current) return;
    running.current = true;
    setBusy(true); setError(''); setNote('');
    try {
      const accepted = await api.invoke('dialog:confirm', { message: t(direction === 'pull' ? 'syncPullConfirm' : 'syncPushConfirm'), detail: t('syncSafeFields') });
      if (!accepted) return;
      const result = await api.invoke('sync:syncNow', { direction });
      if (result.errors?.length) throw new Error(result.errors.map((entry) => entry.error).join('\n'));
      setNote(result.conflicts?.length ? t('syncUnresolved', { fields: result.conflicts.join(', ') }) : t('syncComplete'));
      setStatus(await api.invoke('sync:status'));
      if (result.synced) {
        await resolveLanguage();
        onApplied?.(await api.invoke('settings:get'));
      }
    } catch (reason) { setError(String(reason.message || reason)); }
    finally { running.current = false; setBusy(false); }
  };
  const ready = status?.enabled && !!status.folder && !status.error && !busy;
  return <Dialog title={t('syncPreferencesTitle')} onClose={busy ? undefined : onClose} width={620} buttons={<button className="primary" data-safe-default disabled={busy} onClick={onClose}>{t('close')}</button>}>
    <p>{t('syncSafeFields')}</p>
    {!status && !error && <p role="status">{t('statusScanning')}</p>}
    {status && <>
      <p className="sync-path"><strong>{t('syncFolderLabel')}:</strong> {status.folder || t('none')}</p>
      <p role="status">{!status.enabled ? t('syncDisabled') : status.firstConnection ? t('syncFirstConnection') : status.conflict ? t('syncConflict') : t('syncNoConflict')}</p>
      <div className="sync-choices">
        <section className="sync-choice"><h3>{t('syncPullTitle')}</h3><p>{t('syncPullBody')}</p><button disabled={!ready} onClick={() => run('pull')}>{t('syncPullAction')}</button></section>
        <section className="sync-choice"><h3>{t('syncPushTitle')}</h3><p>{t('syncPushBody')}</p><button disabled={!ready} onClick={() => run('push')}>{t('syncPushAction')}</button></section>
      </div>
      {status.error && <p role="alert" className="error-text">{status.error}</p>}
    </>}
    {error && <p role="alert" className="error-text">{error}</p>}
    {note && <p role="status">{note}</p>}
  </Dialog>;
}
