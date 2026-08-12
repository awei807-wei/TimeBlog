export function mergeTimelineDays(current, incoming) {
  const merged = current.map(day => ({ ...day, untimed: [...day.untimed], timed: [...day.timed] }));
  const byDate = new Map(merged.map(day => [day.date, day]));
  for (const day of incoming) {
    const existing = byDate.get(day.date);
    if (!existing) {
      const copy = { ...day, untimed: [...day.untimed], timed: [...day.timed] };
      merged.push(copy);
      byDate.set(day.date, copy);
      continue;
    }
    for (const bucket of ['untimed', 'timed']) {
      const seen = new Set(existing[bucket].map(entry => entry.id).filter(Boolean));
      for (const entry of day[bucket]) {
        if (entry.id && seen.has(entry.id)) continue;
        existing[bucket].push(entry);
        if (entry.id) seen.add(entry.id);
      }
    }
  }
  return merged;
}
