import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from './core-dialog.jsx';
import { tx } from './backend/i18n.js';
import { compareInstallRecordings, summarizeRecording } from './backend/installer-version-diff.js';

const groupTitle = { a: 'Recorded only in A', both: 'Recorded in both', b: 'Recorded only in B' };
const targetKind = { dir: 'Folder', file: 'File', key: 'Registry key', value: 'Registry value', setvalue: 'Registry value to put back', service: 'Service' };
const notRecorded = () => tx("Not recorded");
const stamp = (value) => value || notRecorded();
const date = (value) => value ? <time dateTime={value}>{new Date(value).toLocaleString()}</time> : notRecorded();

function RecordingSummary({ side, item }) {
  return (
    <div className="recording-diff-summary">
      <h3>{tx(side)}</h3>
      <p className="recording-diff-target">{item.name || tx("Unnamed recording")}</p>
      <dl>
        <dt>{tx("Installer version stamp")}</dt><dd>{stamp(item.stampedVersion)}</dd>
        <dt>{tx("Installer product stamp")}</dt><dd>{stamp(item.stampedProduct)}</dd>
        <dt>{tx("Installer company stamp")}</dt><dd>{stamp(item.stampedCompany)}</dd>
        <dt>{tx("Started")}</dt><dd>{date(item.started)}</dd>
        <dt>{tx("Finished")}</dt><dd>{date(item.finished)}</dd>
        <dt>{tx("Changed files (recorded count)")}</dt><dd>{item.changedFiles?.toLocaleString() ?? notRecorded()}</dd>
      </dl>
      {item.missing && <p className="muted">{tx("This recording has no saved item list. Its coverage is unknown.")}</p>}
      {item.examined < item.total && <p className="muted">{tx("Checked the first {p0} of {p1} saved items.", { p0: item.examined.toLocaleString(), p1: item.total.toLocaleString() })}</p>}
      {item.unrecognized > 0 && <p className="muted">{tx("Omitted {p0} unrecognized or malformed items.", { p0: item.unrecognized.toLocaleString() })}</p>}
    </div>
  );
}

function TargetLabel({ kind, target }) {
  return <span className="recording-diff-target">{target.path}{(kind === 'value' || kind === 'setvalue') && <> › {target.name || tx("(default)")}</>}</span>;
}

function TargetGroup({ group }) {
  return (
    <section>
      <h3>{tx(groupTitle[group.kind])} · {group.count.toLocaleString()}</h3>
      {group.count === 0 ? <p className="muted">{tx("No observed targets in this group.")}</p> : (
        <ul className="tree recording-diff-list">
          {group.rows.map(({ kind, a, b, duplicates, differences }, index) => {
            const distinct = a && b && (a.path !== b.path || a.name !== b.name);
            return (
              <li key={index}>
                <b>{tx(targetKind[kind])}</b>
                {distinct ? (
                  <><div>A · <TargetLabel kind={kind} target={a} /></div><div>B · <TargetLabel kind={kind} target={b} /></div></>
                ) : <div><TargetLabel kind={kind} target={a || b} /></div>}
                {duplicates && <div className="muted">{tx("Repeated target. Showing one spelling per recording. A: {p0} · B: {p1}", { p0: a?.count ?? 0, p1: b?.count ?? 0 })}</div>}
                {!duplicates && differences.length > 0 && <div className="muted">{tx("Recorded evidence differs")} · {differences.map((label) => tx(label)).join(', ')}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {group.rows.length < group.count && <p className="muted">{tx("Showing the first {p0} of {p1} targets in this group.", { p0: group.rows.length.toLocaleString(), p1: group.count.toLocaleString() })}</p>}
    </section>
  );
}

export function InstallerVersionDiffDialog({ index, recordId, loading, onClose }) {
  const [otherId, setOtherId] = useState('');
  const [lostB, setLostB] = useState(false);
  const chooser = useRef(null);
  const a = loading ? null : index.get(recordId);
  const b = loading || otherId === recordId ? null : index.get(otherId);
  const summaryA = useMemo(() => a && summarizeRecording(a), [a]);
  const choices = useMemo(() => a ? [...index].filter(([id, item]) => id !== recordId && item).map(([id, item]) => [id, summarizeRecording(item)]) : [], [a, index, recordId]);
  const canChoose = choices.length > 0;
  useEffect(() => {
    if (!canChoose) return;
    const frame = requestAnimationFrame(() => chooser.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [canChoose]);
  useEffect(() => {
    if (!loading && otherId && !b) {
      setOtherId('');
      setLostB(true);
    }
  }, [loading, otherId, b]);
  const comparison = useMemo(() => a && b ? compareInstallRecordings(a, b) : null, [a, b]);
  const incomplete = comparison && [comparison.a, comparison.b].some((item) => item.missing || item.examined < item.total || item.unrecognized > 0);
  return (
    <Dialog title={tx("Compare Installation Recordings")} width={780} onClose={onClose}
      buttons={<button onClick={onClose}>{tx("Close")}</button>}>
      <div className="recording-diff">
        <p className="muted">{tx("This comparison uses saved recordings only. The installer stamp describes the installer file. Installed versions and recording completeness are unknown.")}</p>
        {loading ? <p role="status">{tx("Refreshing the recording list…")}</p> : !a ? (
          <p className="impact-note" role="alert">{tx("Recording A is no longer available. Close this comparison and select a current recording.")}</p>
        ) : (
          <>
            <label className="cleanup-impact-picker">
              <span>{tx("Recording B")}</span>
              <select ref={chooser} value={b ? otherId : ''} disabled={!canChoose} onChange={(event) => {
                setOtherId(event.target.value);
                setLostB(false);
              }}>
                <option value="">{tx("Choose a second recording…")}</option>
                {choices.map(([id, item]) => <option key={id} value={id}>
                  {item.name || tx("Unnamed recording")} · {stamp(item.stampedVersion)} · {item.finished ? new Date(item.finished).toLocaleString() : notRecorded()} · {id}
                </option>)}
              </select>
            </label>
            {(lostB || (otherId && !b)) && <p role="alert">{tx("Recording B is no longer available. Choose a current recording.")}</p>}
            {!choices.length && <p className="muted">{tx("No other distinct recording is available.")}</p>}
            <div className="recording-diff-pair">
              <RecordingSummary side="Recording A" item={comparison?.a || summaryA} />
              {comparison && <RecordingSummary side="Recording B" item={comparison.b} />}
            </div>
            {comparison && (
              <>
                {comparison.differentProduct && <p className="impact-note">{tx("Installer product stamps differ. These may be recordings of different products.")}</p>}
                {comparison.sameVersionStamp && <p className="muted">{tx("The same version stamp was recorded on both installers. The stamp does not establish installer identity.")}</p>}
                {comparison.metadataDifferences.length > 0 && <p><b>{tx("Recording metadata differs")}</b> · {comparison.metadataDifferences.map((label) => tx(label)).join(', ')}</p>}
                {incomplete && <p className="impact-note">{tx("Some items could not be compared. The groups below describe only the records checked.")}</p>}
                <p role="status">{tx("Observed targets: A only {p0}, both {p1}, B only {p2}.", {
                  p0: comparison.groups[0].count.toLocaleString(), p1: comparison.groups[1].count.toLocaleString(), p2: comparison.groups[2].count.toLocaleString(),
                })}</p>
                {comparison.groups.map((group) => <TargetGroup key={group.kind} group={group} />)}
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
