// Metric definitions: a name plus a SQL aggregate ("Net revenue" = SUM(amount) FILTER (WHERE status = 'completed')),
// saved in this browser per dataset. A tiny semantic layer: the metric cards, the AI's prompts and the SQL box all use the
// same expression, so the same question gives the same number every time. Pure (storage is passed in), no DOM.
import { aggregateFor, measureRank, isIdLike, STATUS_NAME } from './roles.js';

const KEY = 'datadrop.metrics.v1';
const MAX_METRICS = 12;
const q = (id) => `"${String(id).replace(/"/g, '""')}"`;
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Which dataset a set of metrics belongs to: table name + its columns (a reload of the same file finds them again). */
export function metricKey(profile) {
  const names = (profile?.columns || []).map((c) => c.name).join('\u0001');
  let h = 5381;
  for (const ch of `${profile?.table}\u0002${names}`) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

/** Cleaned metric or { error }. The expression is one aggregate over the table: no statements, no comments. */
export function validateMetric(m) {
  const name = String(m?.name ?? '').trim().replace(/\s+/g, ' ');
  const expr = String(m?.expr ?? '').trim().replace(/;+\s*$/, '');
  if (!name) return { error: 'Give the metric a name.' };
  if (name.length > 60) return { error: 'Keep the name under 60 characters.' };
  if (!expr) return { error: 'Write the definition: an aggregate such as SUM("amount").' };
  if (expr.length > 600) return { error: 'Keep the definition under 600 characters.' };
  if (/;|--|\/\*/.test(expr.replace(/'(?:[^']|'')*'/g, "''"))) return { error: 'One expression only: no semicolons or comments.' };
  return { name, expr };
}

/** The query that evaluates a metric (the SQL box and the preview run it through the read-only guard). */
export const metricSql = (m, table) => `SELECT ${m.expr} AS value FROM ${q(table)}`;

export function loadMetrics(storage, profile) {
  try {
    const all = JSON.parse(storage?.getItem(KEY) || '{}');
    const list = all[metricKey(profile)];
    return Array.isArray(list) ? list.map((m) => validateMetric(m)).filter((m) => !m.error) : [];
  } catch { return []; }
}

/** Save (replace) this dataset's metrics; returns false when storage is unavailable. */
export function saveMetrics(storage, profile, list) {
  try {
    const all = JSON.parse(storage.getItem(KEY) || '{}');
    all[metricKey(profile)] = list.slice(0, MAX_METRICS).map((m) => ({ name: m.name, expr: m.expr }));
    storage.setItem(KEY, JSON.stringify(all));
    return true;
  } catch { return false; }
}

/** The block added to the AI's prompts, so a question that names a metric gets exactly its definition. '' when none. */
export function metricPrompt(metrics) {
  if (!metrics?.length) return '';
  return [
    'Defined metrics (the user\'s own definitions). When a question mentions one by name, use exactly this expression, and say in "assumptions" that you used it:',
    ...metrics.map((m) => `- "${m.name}": ${m.expr}`),
  ].join('\n');
}

/** One-click starting points written from the profile: a total, an average for levels, a count, a filtered total. */
export function metricSuggestions(profile) {
  if (!profile?.columns) return [];
  const cols = profile.columns;
  const rc = profile.rowCount || 0;
  const out = [{ name: 'Rows', expr: 'COUNT(*)' }];
  const measure = cols.filter((c) => c.kind === 'quantitative' && !isIdLike(c, rc) && c.distinct !== 1)
    .map((c, i) => ({ c, i })).sort((a, b) => measureRank(a.c) - measureRank(b.c) || a.i - b.i)[0]?.c;
  if (measure) {
    const fn = aggregateFor(measure);
    out.push({ name: `${fn === 'AVG' ? 'Average' : 'Total'} ${measure.name}`, expr: `${fn}(${q(measure.name)})` });
    const status = cols.find((c) => STATUS_NAME.test(c.name) && c.topValues?.length && c.distinct != null && c.distinct <= 12);
    if (status && fn === 'SUM') {
      const v = status.topValues[0].value;
      out.push({ name: `${measure.name} where ${status.name} is ${v}`, expr: `SUM(${q(measure.name)}) FILTER (WHERE ${q(status.name)} = ${lit(v)})` });
    }
  }
  const key = cols.find((c) => c.kind === 'nominal' && c.distinct != null && c.distinct >= 2 && rc && c.distinct >= rc * 0.5);
  if (key) out.push({ name: `Distinct ${key.name}`, expr: `COUNT(DISTINCT ${q(key.name)})` });
  return out.slice(0, 4);
}

/** A metric value for display: whole numbers grouped, decimals to 2 places, big ones in full (a reviewer wants every digit). */
export function formatMetricValue(v) {
  if (v == null) return '—';
  if (typeof v === 'bigint') v = Number(v);
  if (typeof v !== 'number') return String(v);
  if (!Number.isFinite(v)) return String(v);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: Number.isInteger(v) ? 0 : 2, minimumFractionDigits: Number.isInteger(v) ? 0 : 2 }).format(v);
}
