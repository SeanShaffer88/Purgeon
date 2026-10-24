import { useEffect, useMemo, useState } from 'react';

const api = window.api;

const GROUPS = [
  { id: 'startup', label: 'Startup programs', types: ['run', 'folder'] },
  { id: 'tasks', label: 'Scheduled tasks', types: ['task'] },
  { id: 'services', label: 'Services', types: ['service'] },
];

const EFFECT = {
  signin: { label: 'Next sign-in', className: 'fx-explorer' },
  reboot: { label: 'Next restart', className: 'fx-reboot' },
};

// The executable a command line starts: "C:\x\a.exe" -arg  or  C:\x\a.exe -arg
const exeOf = (cmd) => {
  const m = (cmd || '').match(/^\s*"([^"]+)"|^\s*(\S+?\.(?:exe|com|bat|cmd|lnk))\b/i);
  return (m && (m[1] || m[2]) ? m[1] || m[2] : '').toLowerCase();
};

// The installed program whose install folder contains the entry's executable.
function ownerOf(entry, programs) {
  const exe = exeOf(entry.command);
  if (!exe) return null;
  let best = null;
  for (const p of programs) {
    const loc = (p.location || '').replace(/^"|"$/g, '').replace(/\\+$/, '').toLowerCase();
    if (loc.length > 3 && exe.startsWith(loc + '\\') && (!best || loc.length > best.loc.length)) best = { name: p.name, loc };
  }
  return best?.name || null;
}

const simple = (s) => (s || '').toLowerCase().replace(/\.lnk$/, '').replace(/[^a-z0-9]/g, '');
// "Discord" owned by "Discord" or "Zoom Updater" by "Zoom Workplace": only the second is worth showing.
const sameName = (owner, name) => simple(owner).startsWith(simple(name)) || simple(name).startsWith(simple(owner));

export function StartupView({ filter, admin, programs, onError, onStatus }) {
  const [entries, setEntries] = useState(null);
  const [working, setWorking] = useState(new Set());
  const [pending, setPending] = useState({ signin: new Set(), reboot: new Set() });

  const load = async () => {
    try {
      setEntries(await api.invoke('startup:list'));
    } catch (e) {
      onError(e.message);
      setEntries([]);
    }
  };
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!entries) return onStatus('Reading startup entries');
    onStatus(`${entries.filter((e) => e.enabled).length} of ${entries.length} entries start with Windows`);
  }, [entries]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (e) => {
    if (working.has(e.id)) return;
    if (e.admin && admin === false) {
      onError(`"${e.name}" needs administrator rights. Use File › Restart as Administrator.`);
      return;
    }
    if (e.enabled && e.windows) {
      const ok = await api.invoke('dialog:confirm', {
        message: `Stop "${e.name}" from starting?`,
        detail: 'This entry is part of Windows or a Microsoft product. Turning it off is reversible, but some Windows features may stop working until you turn it back on.',
      });
      if (!ok) return;
    }
    setWorking((s) => new Set(s).add(e.id));
    try {
      await api.invoke('startup:set', { entry: e, enable: !e.enabled });
      setPending((p) => {
        const next = new Set(p[e.effect]);
        next.has(e.id) ? next.delete(e.id) : next.add(e.id);
        return { ...p, [e.effect]: next };
      });
    } catch (err) {
      onError(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setWorking((s) => {
        const n = new Set(s);
        n.delete(e.id);
        return n;
      });
      load();
    }
  };

  const groups = useMemo(() => {
    if (!entries) return [];
    const withOwner = entries.map((e) => ({ ...e, owner: ownerOf(e, programs) }));
    const q = filter.trim().toLowerCase();
    const shown = q ? withOwner.filter((e) => `${e.name} ${e.command} ${e.company} ${e.owner || ''} ${e.where}`.toLowerCase().includes(q)) : withOwner;
    return GROUPS.map((g) => ({
      ...g,
      all: withOwner.filter((e) => g.types.includes(e.type)),
      items: shown.filter((e) => g.types.includes(e.type)).sort((a, b) => a.name.localeCompare(b.name)),
    })).filter((g) => g.items.length);
  }, [entries, filter, programs]);

  if (!entries) return <div className="list-empty">Reading startup entries…</div>;

  return (
    <div className="debloat">
      <div className="debloat-bar">
        <span className="legend">
          <span className="pill on">ENABLED</span> starts with Windows
          <span className="pill off">DISABLED</span> kept, but doesn't start
        </span>
        <span className="debloat-actions">
          {pending.signin.size > 0 && <span className="pending-signin">{pending.signin.size} change{pending.signin.size > 1 ? 's' : ''} apply at next sign-in</span>}
          {pending.reboot.size > 0 && (
            <span className="pending-reboot">
              {pending.reboot.size} service change{pending.reboot.size > 1 ? 's' : ''} apply after a restart
            </span>
          )}
        </span>
      </div>

      {groups.length === 0 && <div className="list-empty">No startup entries match.</div>}
      {groups.map((g) => (
        <section key={g.id} className="tweak-group">
          <div className="tweak-group-head">
            <span>{g.label}</span>
            <span className="muted">
              {g.all.filter((e) => e.enabled).length}/{g.all.length} enabled
            </span>
          </div>
          {g.items.map((e) => {
            const fx = EFFECT[e.effect];
            const busy = working.has(e.id);
            return (
              <button
                key={e.id}
                className={`tweak ${e.enabled ? 'on' : 'off'} ${busy ? 'busy' : ''}`}
                onClick={() => toggle(e)}
                aria-pressed={e.enabled}
                title={e.command}
              >
                <span className={`pill ${e.enabled ? 'on' : 'off'}`}>{busy ? '…' : e.enabled ? 'ENABLED' : 'DISABLED'}</span>
                <span className="tweak-text">
                  <span className="tweak-title">
                    {e.name}
                    {e.owner && !sameName(e.owner, e.name) && <span className="owner"> · {e.owner}</span>}
                  </span>
                  <span className="tweak-detail">
                    {[e.company, e.where].filter(Boolean).join(' · ')}
                    {e.command ? ` · ${e.command}` : ''}
                  </span>
                </span>
                <span className="tweak-tags">
                  <span className={`fx ${fx.className}`}>{fx.label}</span>
                  <span className="tag-row">
                    {e.windows && <span className="fx fx-windows">Windows</span>}
                    {e.admin && <span className="fx fx-admin">Admin</span>}
                  </span>
                </span>
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );
}
