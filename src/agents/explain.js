// "How this was calculated": a plain-language plan, what the chart covers, and what it assumes, shown under every
// chart and answer. Pure (no DOM, no DuckDB).
//  - Built-in charts carry a `drill` descriptor (data/drill.js): the sentence is written from it, so it is always true
//    of the SQL that ran.
//  - AI answers bring their own sentence (`rationale`) and a short list of assumptions; the coverage lines are added
//    here either way, because the model can't know what was sampled or empty.

const fmtN = (n) => new Intl.NumberFormat('en-US').format(Math.round(n));

/** One sentence: what the query computes. null when unknown (an AI card without a rationale). */
export function describe(drill, rows = []) {
  if (!drill?.dims?.length) return null;
  const m = drill.measure || { fn: 'COUNT' };
  const verb = m.fn === 'AVG' ? `Averages ${m.column}` : m.fn === 'SUM' ? `Adds up ${m.column}` : 'Counts the rows';
  const [d, d2] = drill.dims;
  const col = (x) => x.column || x.label;
  if (d.kind === 'bucket') {
    const grain = /\(([a-z]+)\)$/.exec(d.label)?.[1] || 'period';
    return `${verb} for each ${grain} of ${col(d)}.`;
  }
  if (d.kind === 'value') {
    const tail = m.fn === 'COUNT' ? (drill.topN ? ', showing the 9 most common and grouping the rest as "Other"' : '') : ', biggest first, up to 15 groups';
    return `${verb} for each ${col(d)}${tail}.`;
  }
  if (d.kind === 'range' && d2?.kind === 'range') return `Splits ${col(d)} and ${col(d2)} into a 30 × 30 grid and counts the rows in each cell.`;
  if (d.kind === 'range') {
    const log = rows[0]?.x_scale === 'log' ? ' (spaced on a log scale because the values are very skewed)' : '';
    return `Splits ${col(d)} into 20 ranges${log} and counts the rows in each.`;
  }
  return null;
}

/** What the numbers cover: the whole file or a sample. */
export function coverage(profile) {
  if (!profile) return null;
  const rc = profile.rowCount || 0;
  if (profile.totalRows && profile.totalRows > rc) {
    const mode = profile.sampleInfo?.mode;
    const how = mode === 'spread' ? ', spread evenly across the file' : mode === 'window' ? ', a consecutive stretch of the file' : '';
    return `This reads a sample: ${fmtN(rc)} of ${fmtN(profile.totalRows)} rows${how}. Totals describe the sample, not the whole file.`;
  }
  return `Uses all ${fmtN(rc)} rows.`;
}

/** Facts that follow from the profile and the chart: empty values left out, averages instead of sums. */
export function caveats(drill, profile) {
  const out = [];
  if (!drill || !profile?.columns) return out;
  const byName = new Map(profile.columns.map((c) => [c.name, c]));
  const used = [...drill.dims.map((d) => d.column).filter(Boolean), drill.measure?.column].filter(Boolean);
  for (const name of [...new Set(used)]) {
    const c = byName.get(name);
    const pct = Number(c?.nullPct);
    if (pct > 0 && profile.rowCount) {
      const isMeasure = name === drill.measure?.column;
      out.push(isMeasure ? `${fmtN((pct / 100) * profile.rowCount)} rows have no ${name}; they add nothing to the result.`
        : `About ${fmtN((pct / 100) * profile.rowCount)} rows have no ${name}, so they are left out of the groups.`);
    }
  }
  if (drill.measure?.fn === 'AVG') out.push(`Averaged, not added up: ${drill.measure.column} is a level (a balance, price or rate), so a total would be meaningless.`);
  return out;
}

/**
 * The block under a card: { how, coverage, assumptions, source }.
 *  card = { drill?, rationale?, assumptions?, rows? }; source is 'rules' (written from the chart) or 'ai' (the model's own words).
 * Returns null when there is nothing honest to say.
 */
export function explainCard(card, profile) {
  if (!card) return null;
  const fromRules = card.drill ? describe(card.drill, card.rows) : null;
  const how = fromRules || (card.rationale ? String(card.rationale).trim() : null);
  const ai = Array.isArray(card.assumptions) ? card.assumptions.map((a) => String(a).trim()).filter(Boolean).slice(0, 4) : [];
  const assumptions = [...caveats(card.drill, profile), ...ai];
  const cov = coverage(profile);
  if (!how && !assumptions.length && !cov) return null;
  return { how, coverage: cov, assumptions, source: fromRules ? 'rules' : 'ai' };
}
