import { useEffect, useLayoutEffect, useState } from 'react';

// Keep large lists bounded while retaining absolute option positions for AT.
export function useWindowedRows(rows, container, selected, datasetKey) {
  const [viewport, setViewport] = useState({ top: 0, height: 700 });
  // CSS fixes .row to this scaled height. Browser zoom scales both equally.
  const [height, setHeight] = useState(30);
  const hasRows = rows.length > 0;
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    let frame;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const row = el.querySelector('.row');
        const measuredHeight = row ? parseFloat(getComputedStyle(row).height) : 30;
        const rowHeight = Number.isFinite(measuredHeight) && measuredHeight > 0 ? measuredHeight : 30;
        setHeight(rowHeight);
        setViewport({ top: el.scrollTop, height: el.clientHeight });
      });
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update); observer.observe(el);
    const firstRow = el.querySelector('.row');
    if (firstRow) observer.observe(firstRow);
    return () => { cancelAnimationFrame(frame); el.removeEventListener('scroll', update); observer.disconnect(); };
  }, [container, datasetKey, hasRows]);
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    el.scrollTop = 0;
    setViewport((value) => ({ ...value, top: 0 }));
  }, [container, datasetKey]);
  useLayoutEffect(() => {
    const index = rows.findIndex((r) => r.key === selected);
    const el = container.current;
    if (!el || index < 0) return;
    const top = index * height;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + height > el.scrollTop + el.clientHeight) el.scrollTop = top + height - el.clientHeight;
  }, [selected, datasetKey, container, height]);
  const count = Math.ceil(viewport.height / height) + 26;
  const first = rows.length > 200 ? Math.min(Math.max(0, rows.length - count), Math.max(0, Math.floor(viewport.top / height) - 12)) : 0;
  const end = rows.length > 200 ? Math.min(rows.length, first + count) : rows.length;
  const selectedIndex = rows.findIndex((row) => row.key === selected);
  return { rows: rows.slice(first, end), first, before: first * height, after: Math.max(0, rows.length - end) * height, selectedIndex, offscreenSelection: selectedIndex >= 0 && (selectedIndex < first || selectedIndex >= end) ? rows[selectedIndex] : null };
}
