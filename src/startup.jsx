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

const baseName = (p) => (p || '').split('\\').pop().toLowerCase();
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

export function StartupView({ filter, admin, programs, onError, onStatus, onRemoveRule }) {
  const [entries, setEntries] = useState(null);
  // Extra detail loaded after the list: measured boot delays, signatures, inbound firewall rules.
  const [boot, setBoot] = useState(null);
  const [sigs, setSigs] = useState({});
  const [inbound, setInbound] = useState(null);
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
    api.invoke('running:bootImpact').then(setBoot).catch(() => setBoot({ available: false, boots: [], impact: {} }));
    api.invoke('running:inbound').then(setInbound).catch(() => setInbound([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!entries) return;
    const files = [...entries.map((e) => exeOf(e.command)), ...(inbound || []).map((r) => r.program.toLowerCase())].filter((f) => /\.exe$/.test(f));
    api.invoke('files:signatures', [...new Set(files)]).then(setSigs).catch(() => {});
  }, [entries, inbound]);
  const impactOf = (e) => boot?.impact?.[e.type === 'service' ? (e.serviceName || '').toLowerCase() : baseName(exeOf(e.command))] || null;
  const sigOf = (file) => sigs[(file || '').toLowerCase()] || null;
  const SigTag = ({ file }) => {
    const s = sigOf(file);
    if (!s) return null;
    return s.status === 'Valid' ? (
      <span className="fx fx-signed" title={`Signed by ${s.signer}`}>Signed</span>
    ) : (
      <span className="fx fx-unsigned" title={s.status === 'NotSigned' ? 'This program is not digitally signed' : `Signature problem: ${s.status}`}>
        {s.status === 'NotSigned' ? 'Unsigned' : 'Bad signature'}
      </span>
    );
  };

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
  const q = filter.trim().toLowerCase();
  const rules = (inbound || []).filter((r) => !q || `${r.display} ${r.program}`.toLowerCase().includes(q));
  const avgBoot = boot?.boots?.length ? boot.boots.reduce((n, b) => n + b.mainPathMs, 0) / boot.boots.length : 0;
  const unsigned = Object.values(sigs).filter((s) => s.status !== 'Valid').length;

  return (
    <div className="debloat">
      <div className="debloat-bar">
        <span className="legend">
          <span className="pill on">ENABLED</span> starts with Windows
          <span className="pill off">DISABLED</span> kept, but doesn't start
        </span>
        <span className="running-summary">
          {entries.filter((e) => e.enabled && (e.type === 'run' || e.type === 'folder')).length} start with Windows · {entries.filter((e) => e.type === 'service' && e.enabled).length} automatic services ·{' '}
          {entries.filter((e) => e.type === 'task' && e.enabled).length} tasks · {(inbound || []).length} accept connections
          {unsigned ? ` · ${unsigned} unsigned` : ''}
          {avgBoot ? ` · start-up takes about ${secs(avgBoot)} (last ${boot.boots.length} slow boots)` : boot && !boot.available ? ' · start-up timings need administrator rights' : ''}
        </span>
        <span className="debloat-actions">
          {pending.signin.size > 0 && <span className="pending-signin">{pending.signin.size} change{pending.signin.size > 1 ? 's apply' : ' applies'} at next sign-in</span>}
          {pending.reboot.size > 0 && (
            <span className="pending-reboot">
              {pending.reboot.size} service change{pending.reboot.size > 1 ? 's apply' : ' applies'} after a restart
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
                    {impactOf(e) && (
                      <span className="fx fx-impact" title={`Windows measured it slowing start-up ${impactOf(e).times} time${impactOf(e).times === 1 ? '' : 's'}`}>
                        +{secs(impactOf(e).avgMs)} at start-up
                      </span>
                    )}
                    {/updat/i.test(`${e.name} ${e.command}`) && <span className="fx fx-updater">Updater</span>}
                    <SigTag file={exeOf(e.command)} />
                    {e.windows && <span className="fx fx-windows">Windows</span>}
                    {e.admin && <span className="fx fx-admin">Admin</span>}
                  </span>
                </span>
              </button>
            );
          })}
        </section>
      ))}
      {rules.length > 0 && (
        <section className="tweak-group">
          <div className="tweak-group-head">
            <span>Programs accepting incoming connections</span>
            <span className="muted">{rules.length} programs · {rules.reduce((n, r) => n + r.names.length, 0)} firewall rules</span>
          </div>
          {rules.map((r) => {
            const owner = ownerOf({ command: `"${r.program}"` }, programs);
            return (
              <div key={r.program} className="tweak inbound">
                <span className="pill on">{r.names.length > 1 ? `${r.names.length} RULES` : 'ALLOWED'}</span>
                <span className="tweak-text">
                  <span className="tweak-title">
                    {r.display}
                    {owner && !sameName(owner, r.display) && <span className="owner"> · {owner}</span>}
                  </span>
                  <span className="tweak-detail">
                    {r.profile} · {r.program}
                    {r.exists ? '' : ' · program no longer exists'}
                  </span>
                </span>
                <span className="tweak-tags">
                  <button className="link" onClick={() => onRemoveRule(r)} title="Removes the rule, after backing it up">
                    Remove rule…
                  </button>
                  <span className="tag-row">
                    <SigTag file={r.program} />
                  </span>
                </span>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
