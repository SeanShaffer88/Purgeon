import { useEffect, useMemo, useState } from 'react';

const api = window.api;

const EFFECT = {
  immediate: { label: 'Applies immediately', className: 'fx-now' },
  explorer: { label: 'Needs Explorer restart', className: 'fx-explorer' },
  reboot: { label: 'Needs reboot', className: 'fx-reboot' },
};

const CATEGORY_ORDER = ['Privacy & telemetry', 'Start, search & taskbar', 'Ads & suggestions', 'Explorer & UI', 'Windows Update', 'App Privacy', 'Settings sync', 'Microsoft Edge', 'Performance'];

export function DebloatView({ filter, admin, onError, onStatus, beforeChange }) {
  const [tweaks, setTweaks] = useState(null);
  const [working, setWorking] = useState(new Set());
  // Tweaks toggled this session whose effect is still pending.
  const [pending, setPending] = useState({ explorer: new Set(), reboot: new Set() });
  const [restarting, setRestarting] = useState(false);

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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!tweaks) return onStatus('Loading tweaks');
    const on = tweaks.filter((t) => t.enabled).length;
    onStatus(`${on} of ${tweaks.length} tweaks enabled`);
  }, [tweaks]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (t) => {
    if (working.has(t.id)) return;
    if (t.admin && admin === false) {
      onError(`"${t.title}" needs administrator rights. Use File › Restart as Administrator.`);
      return;
    }
    if (beforeChange && !(await beforeChange(t.title))) return;
    setWorking((s) => new Set(s).add(t.id));
    try {
      await api.invoke('debloat:set', { id: t.id, enable: !t.enabled });
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

  if (!tweaks) return <div className="list-empty">Reading current settings…</div>;

  return (
    <div className="tweak-list">
      <div className="debloat-bar">
        <span className="legend">
          <span className="pill on">ENABLED</span> tweak applied
          <span className="pill off">DISABLED</span> Windows default
        </span>
        <span className="debloat-actions">
          {pending.reboot.size > 0 && (
            <span className="pending-reboot">
              {pending.reboot.size} change{pending.reboot.size > 1 ? 's' : ''} need{pending.reboot.size > 1 ? '' : 's'} a reboot
            </span>
          )}
          {pending.explorer.size > 0 && (
            <button className="restart-explorer" onClick={restartExplorer} disabled={restarting}>
              {restarting ? 'Restarting…' : `Restart Explorer (${pending.explorer.size})`}
            </button>
          )}
        </span>
      </div>

      {prevDamaged && (
        <div className="debloat-warning" role="note">
          The file that remembers your settings from before these tweaks was damaged, so turning a tweak off now restores the Windows default instead of your exact earlier setting. A copy of the damaged file was kept beside it with “.damaged” in the name.
        </div>
      )}
      {groups.length === 0 && <div className="list-empty">No tweaks match.</div>}
      {groups.map((g) => (
        <section key={g.name} className="tweak-group">
          <div className="tweak-group-head">
            <span>{g.name}</span>
            <span className="muted">
              {g.all.filter((t) => t.enabled).length}/{g.all.length} enabled
            </span>
          </div>
          {g.items.map((t) => {
            const fx = EFFECT[t.effect];
            const busy = working.has(t.id);
            return (
              <button
                key={t.id}
                className={`tweak ${t.enabled ? 'on' : 'off'} ${busy ? 'busy' : ''}`}
                onClick={() => toggle(t)}
                aria-pressed={t.enabled}
                title={t.enabled ? 'Click to restore the Windows default' : 'Click to apply this tweak'}
              >
                <span className={`pill ${t.enabled ? 'on' : 'off'}`}>{busy ? '…' : t.enabled ? 'ENABLED' : t.partial ? 'PARTIAL' : 'DISABLED'}</span>
                <span className="tweak-text">
                  <span className="tweak-title">{t.title}</span>
                  <span className="tweak-detail">{t.detail}</span>
                </span>
                <span className="tweak-tags">
                  <span className={`fx ${fx.className}`}>{fx.label}</span>
                  {t.admin && <span className="fx fx-admin">Admin</span>}
                </span>
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );
}
