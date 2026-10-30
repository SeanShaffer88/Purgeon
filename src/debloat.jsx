import { tx } from './backend/i18n.js';
import { useEffect, useMemo, useState } from 'react';

const api = window.api;

const EFFECT = {
  immediate: { label: 'Applies immediately', className: 'fx-now' },
  explorer: { label: 'Needs Explorer restart', className: 'fx-explorer' },
  reboot: { label: 'Needs reboot', className: 'fx-reboot' },
};

const CATEGORY_ORDER = ['Privacy & telemetry', 'Start, search & taskbar', 'Ads & suggestions', 'Explorer & UI', 'Windows Update', 'App Privacy', 'Settings sync', 'Microsoft Edge', 'Performance'];

const RECOVERY_OUTCOMES = {
  applied: 'Change applied.', noChanges: 'No changes were needed.',
  rolledBack: 'Eligible owned values were restored to captured originals.',
  interruptedPartial: 'Recovery was interrupted or only partially completed. Inspect the retained journal.',
  conflict: 'Current values conflict with retained evidence. Registry rollback is blocked; inspect or explicitly accept current state.',
  acceptedCurrent: 'Current state acknowledged. No registry values were written.',
};

export function DebloatView({ filter, onError, onStatus, beforeChange }) {
  const [tweaks, setTweaks] = useState(null);
  const [working, setWorking] = useState(new Set());
  // Tweaks toggled this session whose effect is still pending.
  const [pending, setPending] = useState({ explorer: new Set(), reboot: new Set() });
  const [restarting, setRestarting] = useState(false);
  const [outcome, setOutcome] = useState('');

  const [prevDamaged, setPrevDamaged] = useState(false);
  const load = async () => {
    try {
      setTweaks(await api.invoke('debloat:list'));
      setPrevDamaged(await api.invoke('debloat:previousDamaged').catch(() => false));
    } catch (e) {
      onError(e.message);
      setTweaks([]);
    }
  };
  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!tweaks) return onStatus('Loading tweaks');
    const on = tweaks.filter((t) => !t.unknown && t.enabled).length;
    const unknown = tweaks.filter((t) => t.unknown).length;
    const partial = tweaks.filter((t) => !t.unknown && t.partial).length;
    onStatus(`${on} of ${tweaks.length} tweaks enabled; ${partial} partial; ${unknown} unknown`);
  }, [tweaks]);

  const toggle = async (t) => {
    if (working.has(t.id) || t.unknown || t.recovery) return;
    if (beforeChange && !(await beforeChange(t.title))) return;
    setOutcome('');
    setWorking((s) => new Set(s).add(t.id));
    try {
      const result = await api.invoke('debloat:set', { id: t.id, enable: !t.enabled });
      if (result?.restoredOriginal) setOutcome(tx('Restored captured original registry values. Empty created keys may remain.'));
      else if (result?.appliedDefaults) setOutcome(tx('Applied catalog default fallback values; captured originals were unavailable. Empty created keys may remain.'));
      if (t.effect !== 'immediate') {
        setPending((p) => {
          const next = new Set(p[t.effect]);
          next.has(t.id) ? next.delete(t.id) : next.add(t.id); // toggling back cancels the pending change
          return { ...p, [t.effect]: next };
        });
      }
    } catch (e) {
      onError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setWorking((s) => {
        const n = new Set(s);
        n.delete(t.id);
        return n;
      });
      load();
    }
  };

  const recover = async (t, decision) => {
    const recovery = t.recovery;
    if (working.has(t.id) || !recovery?.safeDecisions?.includes(decision)) return;
    if ((recovery.legacy && decision === 'rollbackOwned') || (recovery.mappingMismatch && decision !== 'acceptCurrent')) return;
    if (decision === 'rollbackOwned' && recovery.resources.some((resource) => !['before', 'target'].includes(resource.classification))) return;
    setOutcome('');
    setWorking((s) => new Set(s).add(t.id));
    try {
      const result = await api.invoke('debloat:recover', { tweakId: t.id, transactionId: recovery.transactionId, decision });
      setOutcome(RECOVERY_OUTCOMES[result?.outcome] || 'Recovery request finished. Review the refreshed native state.');
    } catch (e) {
      onError(e.message);
    } finally {
      await load();
      setWorking((s) => { const next = new Set(s); next.delete(t.id); return next; });
    }
  };

  const restartExplorer = async () => {
    setRestarting(true);
    try {
      await api.invoke('debloat:restartExplorer');
      setPending((p) => ({ ...p, explorer: new Set() }));
    } catch (e) {
      onError(e.message);
    } finally {
      setRestarting(false);
    }
  };

  const groups = useMemo(() => {
    if (!tweaks) return [];
    const q = filter.trim().toLowerCase();
    const shown = q ? tweaks.filter((t) => `${t.title} ${t.detail} ${t.category}`.toLowerCase().includes(q)) : tweaks;
    // Categories the order list does not name are appended in data order — a
    // tweak whose category is missing here must never become invisible
    // (the App Privacy and Settings sync sections once were, for a release).
    const order = [...CATEGORY_ORDER, ...new Set(tweaks.map((t) => t.category).filter((c) => !CATEGORY_ORDER.includes(c)))];
    return order.map((c) => ({ name: c, all: tweaks.filter((t) => t.category === c), items: shown.filter((t) => t.category === c) })).filter((g) => g.items.length);
  }, [tweaks, filter]);

  if (!tweaks) return <div className="list-empty">{tx("Reading current settings…")}</div>;

  return (
    <div className="tweak-list">
      <div className="debloat-bar">
        <span className="legend">
          <span className="pill on">{tx("ENABLED")}</span>{tx(" tweak applied ")}<span className="pill off">{tx("DISABLED")}</span>{tx(" tweak not applied ")}<span className="pill off">{tx("PARTIAL")}</span>{tx(" mixed values ")}<span className="pill off">{tx("UNKNOWN")}</span>{tx(" status unavailable")}</span>
        <span className="debloat-actions">
          {pending.reboot.size > 0 && (
            <span className="pending-reboot">
              {pending.reboot.size}{tx(" change")}{pending.reboot.size > 1 ? tx("s") : ''}{tx(" need")}{pending.reboot.size > 1 ? '' : tx("s")}{tx(" a reboot")}</span>
          )}
          {pending.explorer.size > 0 && (
            <button className="restart-explorer" onClick={restartExplorer} disabled={restarting}>
              {restarting ? tx("Restarting…") : tx("Restart Explorer ({p0})", { p0: (pending.explorer.size) })}
            </button>
          )}
        </span>
      </div>

      {prevDamaged && (
        <div className="debloat-warning" role="note">{tx("The legacy previous-settings file was damaged and retained for inspection. Native recovery uses its own captured originals when available; otherwise consent explicitly identifies a catalog default fallback. Legacy records do not authorize machine recovery.")}</div>
      )}
      <div className="debloat-warning" role="note">{tx('Each change requires native consent; protected settings may prompt for administrator approval. Restore uses captured original values when available, or an explicitly disclosed catalog default fallback. Empty registry keys created by a tweak may remain after its values are restored.')}</div>
      {outcome && <div className="debloat-warning" role="status">{outcome}</div>}
      {groups.length === 0 && <div className="list-empty">{tx("No tweaks match.")}</div>}
      {groups.map((g) => (
        <section key={g.name} className="tweak-group">
          <div className="tweak-group-head">
            <span>{g.name}</span>
            <span className="muted">
              {g.all.filter((t) => !t.unknown && t.enabled).length}/{g.all.length}{tx(" enabled")}</span>
          </div>
          {g.items.map((t) => {
            const fx = EFFECT[t.effect];
            const busy = working.has(t.id);
            const recovery = t.recovery;
            const recoveryConflict = recovery?.resources.some((resource) => !['before', 'target'].includes(resource.classification));
            return (
              <div key={t.id}>
              <button
                className={`tweak ${!t.unknown && t.enabled ? 'on' : 'off'} ${busy ? 'busy' : ''}`}
                onClick={() => toggle(t)}
                disabled={busy || t.unknown || !!recovery}
                aria-pressed={t.unknown || t.partial ? 'mixed' : t.enabled}
                title={t.unknown ? (t.error || tx('Status could not be read. Refresh before changing this setting.')) : t.enabled ? tx("Review restoration of captured originals or catalog default fallback") : tx("Review and apply this tweak")}
              >
                <span className={`pill ${!t.unknown && t.enabled ? 'on' : 'off'}`}>{busy ? '…' : t.unknown ? tx('UNKNOWN') : t.partial ? tx("PARTIAL") : t.enabled ? tx("ENABLED") : tx("DISABLED")}</span>
                <span className="tweak-text">
                  <span className="tweak-title">{t.title}</span>
                  <span className="tweak-detail">{t.detail}</span>
                  {t.unknown && <span className="tweak-detail">{t.error || tx('Status could not be read. Refresh before changing this setting.')}</span>}
                  {!t.unknown && t.partial && <span className="tweak-detail">{tx('Only some values match this tweak. Review native consent before applying all values.')}</span>}
                </span>
                <span className="tweak-tags">
                  <span className={`fx ${fx.className}`}>{fx.label}</span>
                  {t.admin && <span className="fx fx-admin">{tx("Admin")}</span>}
                </span>
              </button>
              {recovery && (
                <div className="debloat-warning" role="region" aria-label={`Interrupted change: ${t.title}`} aria-busy={busy}>
                  <strong>Interrupted Debloat change</strong>
                  <p>Inspect retained evidence before deciding. Nothing is replayed automatically. Ordinary changes stay blocked until native recovery resolves this journal.</p>
                  {recovery.outcome && <p>{RECOVERY_OUTCOMES[recovery.outcome] || recovery.outcome}</p>}
                  {recovery.legacy && <p>This legacy journal has no provable target. Only inspection and metadata-only acceptance are available.</p>}
                  {recovery.mappingMismatch && <p>The CurrentControlSet mapping changed. Automatic inspection/reconciliation and rollback are blocked. Manually review the resources or explicitly accept current state without registry writes.</p>}
                  <div style={{ overflowX: 'auto' }}>
                    <table><thead><tr><th scope="col">Resource</th><th scope="col">Captured before</th><th scope="col">Planned target</th><th scope="col">Current</th><th scope="col">Classification</th></tr></thead>
                      <tbody>{recovery.resources.map((resource, index) => <tr key={`${resource.key}:${resource.name}:${index}`}>
                        <th scope="row">{resource.key}\{resource.name || '(Default)'}</th><td>{resource.before}</td><td>{resource.target}</td><td>{resource.current}</td>
                        <td>{({ before: 'Matches captured before', target: 'Matches planned target', other: 'Conflict: other value', unknown: 'Unknown: could not read' })[resource.classification] || 'Unknown'}</td>
                      </tr>)}</tbody>
                    </table>
                  </div>
                  <p>Inspect / Reconcile reads values and updates recovery metadata only. Rollback writes captured originals only where native ownership checks permit it; conflicts block rollback. Accept current state acknowledges the journal without registry writes. Empty created keys may remain.</p>
                  <div className="debloat-actions">
                    <button disabled={busy || recovery.mappingMismatch || !recovery.safeDecisions.includes('reconcile')} onClick={() => recover(t, 'reconcile')}>Inspect / Reconcile</button>
                    <button disabled={busy || recovery.legacy || recovery.mappingMismatch || recoveryConflict || !recovery.safeDecisions.includes('rollbackOwned')} onClick={() => recover(t, 'rollbackOwned')}>Rollback eligible values…</button>
                    <button disabled={busy || !recovery.safeDecisions.includes('acceptCurrent')} onClick={() => recover(t, 'acceptCurrent')}>Accept current state…</button>
                  </div>
                  {busy && <p role="status">Waiting for native recovery consent or execution…</p>}
                </div>
              )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
