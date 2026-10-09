// What a column *means*, from its name and profile: identifier, additive measure, status-like category. Pure, no DOM.
// Shared by the chart suggester (agents/pipeline.js) and the Data tab (ui/gridmodel.js), so an account number is an
// identifier everywhere and never a number to sum.

/** Names that are identifiers even when stored as numbers: ids, uuids, account/card/iban/reference/txn numbers, zip, phone. */
export const ID_NAME = /(^id$|_id$|^id_|uuid|^index$|^unnamed|(^|_)(acct|account|card|iban|ref|reference|txn|trace|zip|postal|phone|routing|swift)(_?(no|num|number|id|code))?$)/i;

/** Names that hold money or prices. */
export const MONEY_NAME = /(amount|amt|balance|price|cost|fee|revenue|sales|total|payment|salary|wage|income|debit|credit|charge|tax|spend|spent|premium|principal|interest|profit|loss|pnl|deposit|withdraw|refund|payout|invoice|budget|value|close|open|high|low)/i;

/** Measures that must not be summed: a balance, price, rate or age is a level, so averaging over a period is the honest aggregate. */
export const NON_ADDITIVE = /(balance|price|rate|ratio|pct|percent|score|age|temp|latitude|longitude|(^|_)(lat|lng|lon)$|close|open|high|low|avg|mean|median)/i;

/** Names of the columns that split data into a few meaningful groups. */
export const STATUS_NAME = /(status|state|type|category|class|kind|stage|channel|method|direction|result|outcome|segment|tier)/i;

export const isIdName = (c) => ID_NAME.test(c?.name || '');

/** A row key (id, index, uuid): different on every row by design, never a group. */
export const isRowKeyName = (c) => /^(id|index|unnamed.*)$|uuid/i.test(c?.name || '');

/** An identifier by name, or an integer column where (almost) every row is different. */
export function isIdLike(c, rowCount) {
  if (isIdName(c)) return true;
  if (c.kind === 'quantitative' && rowCount > 20 && c.distinct >= rowCount * 0.98 &&
      Number.isInteger(Number(c.min)) && Number.isInteger(Number(c.max)) && /INT/i.test(c.type || '')) return true;
  return false;
}

/** SUM for additive measures (amounts, counts), AVG for levels (balances, prices, rates). */
export const aggregateFor = (c) => (NON_ADDITIVE.test(c?.name || '') ? 'AVG' : 'SUM');

/** Sort rank for picking the headline measure: additive money first, other additive next, levels last. */
export function measureRank(c) {
  const additive = !NON_ADDITIVE.test(c.name);
  if (additive && MONEY_NAME.test(c.name)) return 0;
  return additive ? 1 : 2;
}
