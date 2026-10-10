// Views: three ways to arrange the same data for different jobs. A view changes layout, defaults and wording only: the
// engine, the SQL, the rows and the sample notice are identical in all of them. Pure (storage is passed in), no DOM.
//
// Also share links: "?url=<data url>&view=review&tab=data" reopens a dataset in a view, without changing the viewer's own
// saved choice.
import { MONEY_NAME, NON_ADDITIVE, STATUS_NAME, isIdName } from './roles.js';

const KEY = 'datadrop.view.v1';

export const MODES = {
  overview: { label: 'Overview', hint: 'The gist: charts and your metrics', tab: 'charts', rail: false, density: 'comfortable', explain: false },
  explore: { label: 'Explore', hint: 'Types, nulls, SQL: check the data before trusting it', tab: 'charts', rail: true, density: 'compact', explain: true },
  review: { label: 'Review', hint: 'Rows and records: reconcile and spot exceptions', tab: 'data', rail: true, density: 'compact', explain: false },
};
export const DEFAULT_MODE = 'overview';
export const TABS = ['charts', 'data', 'sql'];
export const isMode = (m) => Object.prototype.hasOwnProperty.call(MODES, m);

/**
 * 'review' when the table looks like transactions: an additive money column (amount, debit, fee…) AND a second signal (a
 * status-like group, or an account / transaction identifier). Prices and balances don't count, so a stock file is not
 * mistaken for a ledger. null otherwise. Only ever a suggestion.
 */
export function suggestMode(profile) {
  const cols = profile?.columns;
  if (!cols?.length) return null;
  const money = cols.some((c) => c.kind === 'quantitative' && /^(DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC)/i.test(c.type || '') && MONEY_NAME.test(c.name) && !NON_ADDITIVE.test(c.name));
  if (!money) return null;
  const status = cols.some((c) => STATUS_NAME.test(c.name) && c.kind === 'nominal');
  const ident = cols.some((c) => isIdName(c) && !/^(id|index|unnamed.*)$/i.test(c.name));
  return status || ident ? 'review' : null;
}

/** { mode, dismissed: { [datasetKey]: true } } from storage; the default when anything is wrong. */
export function loadPrefs(storage) {
  try {
    const v = JSON.parse(storage?.getItem(KEY) || '{}');
    return { mode: isMode(v.mode) ? v.mode : DEFAULT_MODE, dismissed: v.dismissed && typeof v.dismissed === 'object' ? v.dismissed : {} };
  } catch { return { mode: DEFAULT_MODE, dismissed: {} }; }
}
export function savePrefs(storage, prefs) {
  try { storage.setItem(KEY, JSON.stringify({ mode: prefs.mode, dismissed: prefs.dismissed || {} })); return true; } catch { return false; }
}

/** { url, view, tab } from a query string (?url=…&view=…) or a hash (#view=…&tab=…); each only when valid. */
export function parseShare(search) {
  const p = new URLSearchParams(String(search || '').replace(/^[?#]/, ''));
  const url = p.get('url') || undefined;
  const view = p.get('view');
  const tab = p.get('tab');
  return { url, view: isMode(view) ? view : undefined, tab: TABS.includes(tab) ? tab : undefined };
}

const SHAREABLE = /^(https?|s3|gs|hf):\/\//i;
const LINK_IN_PATH = /^(.*?\/)((?:https?|s3|gs|hf):\/.*)$/i;

/**
 * The app's folder and the data link written after it: /datadrop/https://host/a.csv?dl=1 ->
 * { base: '/datadrop/', link: 'https://host/a.csv?dl=1' }. The link's own query is part of it; a '#' in the link
 * travels as %23 (the address's own hash carries the view). Some servers squash '//' to '/': put it back.
 */
export function linkFromLocation({ pathname = '/', search = '' } = {}) {
  const m = String(pathname).match(LINK_IN_PATH);
  if (!m) return { base: String(pathname).replace(/[^/]*$/, '') || '/', link: '' };
  const link = (m[2] + search).replace(/^([a-z0-9]+):\/(?!\/)/i, '$1://').replace(/%23/gi, '#');
  return { base: m[1], link };
}

/** The address path for a data link: the app's folder, then the link as pasted (only '#' and spaces escaped). */
export function linkPath(base, link) {
  return base + String(link).replace(/#/g, '%23').replace(/ /g, '%20');
}

/** A link that reopens this dataset in this view. null when there is no public URL to point at (a local file). */
export function buildShareLink({ origin, base, url, view, tab }) {
  if (!url || !SHAREABLE.test(url)) return null;
  const q = new URLSearchParams();
  if (isMode(view)) q.set('view', view);
  if (TABS.includes(tab) && tab !== MODES[view]?.tab) q.set('tab', tab);
  const hash = q.toString();
  return `${origin}${linkPath(base, url)}${hash ? `#${hash}` : ''}`;
}
