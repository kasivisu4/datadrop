// Read-only SQL guard shared by the agents (AI-written SQL) and the SQL box (SQL you type). Pure, no DOM.

const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|ATTACH|DETACH|COPY|PRAGMA|INSTALL|LOAD|EXPORT|IMPORT|CALL|SET|RESET|TRUNCATE|REPLACE\s+INTO|MERGE|GRANT|VACUUM|CHECKPOINT|USE|BEGIN|COMMIT|ROLLBACK)\b/i;

/**
 * Validates that sql is a single read-only SELECT/WITH statement. Returns the cleaned SQL
 * (comments + trailing semicolons removed). Throws Error('Unsafe SQL: ...') otherwise.
 */
export function guardSQL(sql) {
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('Unsafe SQL: empty query');
  // strip comments
  let s = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
  s = s.replace(/[;\s]+$/g, '').trim();
  // blank out string literals and quoted identifiers before structural checks
  const masked = s.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  if (masked.includes(';')) throw new Error('Unsafe SQL: multiple statements are not allowed');
  const head = masked.replace(/^[\s(]+/, '');
  if (!/^(SELECT|WITH|FROM)\b/i.test(head)) {
    const kw = (head.match(/^\w+/) || ['?'])[0].toUpperCase();
    throw new Error(`Unsafe SQL: only SELECT/WITH queries are allowed (got ${kw})`);
  }
  const bad = masked.match(FORBIDDEN);
  if (bad) throw new Error(`Unsafe SQL: keyword ${bad[1].toUpperCase()} is not allowed`);
  return s;
}
