import { tx } from './backend/i18n.js';
import { useEffect, useMemo, useRef, useState } from 'react';

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
const entriesForMode = (entries, mode) => entries.filter((entry) => mode === 'services' ? entry.type === 'service' : entry.type !== 'service');

export function StartupView({ mode = 'startup', filter, admin, programs, onError, onStatus, onRemoveRule }) {
  const servicesOnly = mode === 'services';
  const alive = useRef(true);
  const loadGeneration = useRef(0);
  const [entries, setEntries] = useState(null);
  // Extra detail loaded after the list: measured boot delays, signatures, inbound firewall rules.
  const [boot, setBoot] = useState(null);
  const [sigs, setSigs] = useState({});
  const [inbound, setInbound] = useState(null);
  // Entries worth a second look: odd location, unsigned, or new ({ id: [reasons] }).
  const [trust, setTrust] = useState({});
  const [working, setWorking] = useState(new Set());
  const [pending, setPending] = useState({ signin: new Set(), reboot: new Set() });

  const load = async () => {
    if (!alive.current) return;
    const generation = ++loadGeneration.current;
    const current = () => alive.current && generation === loadGeneration.current;
    try {
      const result = await api.invoke('startup:list');
      if (current()) setEntries(entriesForMode(result, mode));
    } catch (e) {
      if (!current()) return;
      onError(e.message);
      setEntries([]);
    }
  };
  useEffect(() => {
    alive.current = true;
    let active = true;
    load();
    api.invoke('running:bootImpact').then((value) => { if (active) setBoot(value); }).catch(() => { if (active) setBoot({ available: false, boots: [], impact: {} }); });
    if (!servicesOnly) api.invoke('running:inbound').then((value) => { if (active) setInbound(value); }).catch(() => { if (active) setInbound([]); });
    return () => { active = false; alive.current = false; loadGeneration.current++; };
  }, []);
  useEffect(() => {
    if (!entries) return;
    let active = true;
    const files = [...entries.map((e) => exeOf(e.command)), ...(inbound || []).map((r) => r.program.toLowerCase())].filter((f) => /\.exe$/.test(f));
    api.invoke('files:signatures', [...new Set(files)]).then((value) => { if (active) setSigs(value); }).catch(() => {});
    return () => { active = false; };
  }, [entries, inbound]);
  useEffect(() => {
    let active = true;
    if (entries) api.invoke('startup:trust', entries).then((value) => { if (active) setTrust(value); }).catch(() => {});
    return () => { active = false; };
  }, [entries]);
  const impactOf = (e) => boot?.impact?.[e.type === 'service' ? (e.serviceName || '').toLowerCase() : baseName(exeOf(e.command))] || null;
  const sigOf = (file) => sigs[(file || '').toLowerCase()] || null;
  const SigTag = ({ file }) => {
    const s = sigOf(file);
    if (!s) return null;
    return s.status === 'Valid' ? (
      <span className="fx fx-signed" title={tx("Signed by {p0}", { p0: (s.signer) })}>{tx("Signed")}</span>
    ) : (
      <span className="fx fx-unsigned" title={s.status === 'NotSigned' ? tx("This program is not digitally signed") : tx("Signature problem: {p0}", { p0: (s.status) })}>
        {s.status === 'NotSigned' ? tx("Unsigned") : tx("Bad signature")}
      </span>
    );
  };

  useEffect(() => {
    if (!entries) return onStatus(servicesOnly ? 'Reading services' : 'Reading startup entries');
    onStatus(`${entries.filter((e) => e.enabled).length} of ${entries.length} ${servicesOnly ? 'services enabled' : 'entries start with Windows'}`);
  }, [entries, servicesOnly]);

  const toggle = async (e) => {
    if (working.has(e.id)) return;
    if (e.admin && admin === false) {
      onError(tx("\"{p0}\" needs administrator rights. Use File › Restart as Administrator.", { p0: (e.name) }));
      return;
    }
    if (e.enabled && e.windows) {
      const ok = await api.invoke('dialog:confirm', {
        message: `Stop "${e.name}" from starting?`,
        detail: 'This entry is part of Windows or a Microsoft product. Turning it off is reversible, but some Windows features may stop working until you turn it back on.',
      });
      if (!ok || !alive.current) return;
    }
    setWorking((s) => new Set(s).add(e.id));
    try {
      await api.invoke('startup:set', { entry: e, enable: !e.enabled });
      if (!alive.current) return;
      setPending((p) => {
        const next = new Set(p[e.effect]);
        next.has(e.id) ? next.delete(e.id) : next.add(e.id);
        return { ...p, [e.effect]: next };
      });
    } catch (err) {
      if (alive.current) onError(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      if (alive.current) {
      setWorking((s) => {
        const n = new Set(s);
        n.delete(e.id);
        return n;
      });
      load();
      }
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

  if (!entries) return <div className="list-empty">{tx(servicesOnly ? 'Reading services…' : 'Reading startup entries…')}</div>;
  const q = filter.trim().toLowerCase();
  const rules = servicesOnly ? [] : (inbound || []).filter((r) => !q || `${r.display} ${r.program}`.toLowerCase().includes(q));
  const avgBoot = boot?.boots?.length ? boot.boots.reduce((n, b) => n + b.mainPathMs, 0) / boot.boots.length : 0;
  const unsigned = Object.values(sigs).filter((s) => s.status !== 'Valid').length;

  return (
    <div className="tweak-list">
      <div className="debloat-bar">
        <span className="legend">
          <span className="pill on">{tx("ENABLED")}</span>{tx(" starts with Windows")}<span className="pill off">{tx("DISABLED")}</span>{tx(" kept, but doesn't start")}</span>
        <span className="running-summary">
          {servicesOnly ? tx('{p0} automatic services', { p0: entries.filter((e) => e.enabled).length }) : <>{entries.filter((e) => e.enabled && (e.type === 'run' || e.type === 'folder')).length}{tx(' start with Windows · ')}{entries.filter((e) => e.type === 'task' && e.enabled).length}{tx(' tasks · ')}{(inbound || []).length}{tx(' accept connections')}</>}{unsigned ? tx(" · {p0} unsigned", { p0: (unsigned) }) : ''}
          {Object.keys(trust).length ? tx(" · {p0} worth checking", { p0: (Object.keys(trust).length) }) : ''}
          {avgBoot ? tx(" · start-up takes about {p0} (last {p1} slow boots)", { p0: (secs(avgBoot)), p1: (boot.boots.length) }) : boot && !boot.available ? tx(" · start-up timings need administrator rights") : ''}
        </span>
        <span className="debloat-actions">
          {pending.signin.size > 0 && <span className="pending-signin">{pending.signin.size}{tx(" change")}{pending.signin.size > 1 ? tx("s apply") : tx(" applies")}{tx(" at next sign-in")}</span>}
          {pending.reboot.size > 0 && (
            <span className="pending-reboot">
              {pending.reboot.size}{tx(" service change")}{pending.reboot.size > 1 ? tx("s apply") : tx(" applies")}{tx(" after a restart")}</span>
          )}
        </span>
      </div>

      {groups.length === 0 && <div className="list-empty">{tx(servicesOnly ? 'No services match.' : 'No startup entries match.')}</div>}
      {groups.map((g) => (
        <section key={g.id} className="tweak-group">
          <div className="tweak-group-head">
            <span>{tx(g.label)}</span>
            <span className="muted">
              {g.all.filter((e) => e.enabled).length}/{g.all.length}{tx(" enabled")}</span>
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
                aria-label={tx("{p0}, {p1}, {p2}. Click to turn {p3}.", { p0: (e.name), p1: (e.enabled ? 'enabled' : 'disabled'), p2: (e.where), p3: (e.enabled ? 'off' : 'on') })}
                title={e.command}
              >
                <span className={`pill ${e.enabled ? 'on' : 'off'}`}>{busy ? '…' : e.enabled ? tx("ENABLED") : tx("DISABLED")}</span>
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
                    {e.type === 'service' && e.enabled && (
                      <button
                        className={`link ${e.delayed ? 'on' : ''}`}
                        onClick={() => {
                          if (working.has(e.id)) return;
                          setWorking((s) => new Set(s).add(e.id));
                          api.invoke('startup:delayed', { entry: e, delayed: !e.delayed }).then(() => {
                            if (!alive.current) return;
                            setPending((p) => {
                              const next = new Set(p.reboot);
                              next.has(e.id) ? next.delete(e.id) : next.add(e.id);
                              return { ...p, [e.effect]: next };
                            });
                            load();
                          }).catch((err) => { if (alive.current) onError(err.message); }).finally(() => {
                            if (alive.current) setWorking((s) => { const n = new Set(s); n.delete(e.id); return n; });
                          });
                        }}
                        aria-label={tx("{p0}, {p1}. Click to turn {p2} delayed start.", { p0: (e.name), p1: (e.delayed ? 'delayed start on' : 'delayed start off'), p2: (e.delayed ? 'off' : 'on') })}
                        title={e.delayed ? tx("Service starts normally after boot") : tx("Service starts after a short delay following boot")}
                      >
                        {e.delayed ? tx("DELAYED") : tx("DELAY")}
                      </button>
                    )}
                    {trust[e.id] && (
                      <span className="fx fx-unsigned" title={trust[e.id].join('\n')}>{tx("⚠ Check")}</span>
                    )}
                    {impactOf(e) && (
                      <span className="fx fx-impact" title={tx("Windows measured it slowing start-up {p0} time{p1}", { p0: (impactOf(e).times), p1: (impactOf(e).times === 1 ? '' : 's') })}>
                        +{secs(impactOf(e).avgMs)}{tx(" at start-up")}</span>
                    )}
                    {/updat/i.test(`${e.name} ${e.command}`) && <span className="fx fx-updater">{tx("Updater")}</span>}
                    <SigTag file={exeOf(e.command)} />
                    {e.windows && <span className="fx fx-windows">{tx("Windows")}</span>}
                    {e.admin && <span className="fx fx-admin">{tx("Admin")}</span>}
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
            <span>{tx("Programs accepting incoming connections")}</span>
            <span className="muted">{rules.length}{tx(" programs · ")}{rules.reduce((n, r) => n + r.names.length, 0)}{tx(" firewall rules")}</span>
          </div>
          {rules.map((r) => {
            const owner = ownerOf({ command: `"${r.program}"` }, programs);
            return (
              <div key={r.program} className="tweak inbound">
                <span className="pill on">{r.names.length > 1 ? tx("{p0} RULES", { p0: (r.names.length) }) : tx("ALLOWED")}</span>
                <span className="tweak-text">
                  <span className="tweak-title">
                    {r.display}
                    {owner && !sameName(owner, r.display) && <span className="owner"> · {owner}</span>}
                  </span>
                  <span className="tweak-detail">
                    {r.profile} · {r.program}
                    {r.exists ? '' : tx(" · program no longer exists")}
                  </span>
                </span>
                <span className="tweak-tags">
                  <button className="link" onClick={() => onRemoveRule(r)} title={tx("Removes the rule, after backing it up")}>{tx("Remove rule…")}</button>
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
