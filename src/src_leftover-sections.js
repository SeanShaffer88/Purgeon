// One inventory pass; groups may overlap, so each matching group keeps its row.
export function leftoverSections(items, definitions) {
  const byKind = new Map();
  definitions.forEach((group, index) => {
    for (const kind of new Set(group.kinds)) {
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push(index);
    }
  });
  const programs = new Map();
  items.forEach((it, idx) => {
    const program = it.program || '';
    if (!programs.has(program)) programs.set(program, definitions.map((g) => ({ ...g, id: `${program}|${g.id}`, rows: [] })));
    const groups = programs.get(program);
    for (const index of byKind.get(it.kind) || []) groups[index].rows.push({ it, idx });
  });
  return [...programs].map(([program, all]) => {
    const groups = all.filter((g) => g.rows.length);
    return { program, groups, rows: groups.flatMap((g) => g.rows) };
  });
}
