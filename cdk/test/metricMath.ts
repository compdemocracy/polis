/**
 * A small evaluator for the CloudWatch metric-math subset the worker-class
 * alarms use (IF, FILL, + - comparisons, && ||, numbers, metric ids), so a
 * test can evaluate the SYNTHESIZED expression for one datapoint.
 *
 * Missing data is modelled two ways, and a guard must hold under both:
 *  - 'zero': a missing datapoint reads as 0 in arithmetic and comparisons
 *    (AWS "Using metric math": the documented behaviour for arithmetic on a
 *    series with gaps). This is the model the bare sum was unsafe under.
 *  - 'propagate': a missing operand makes the result missing (no datapoint;
 *    the alarm then applies TreatMissingData).
 * FILL(m, v) replaces a missing datapoint with v in both models.
 */
export type Missing = 'zero' | 'propagate';
type Val = number | undefined;
type Tok = { t: 'num' | 'id' | 'op' | 'p'; v: string };

const tokenize = (src: string): Tok[] => {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(&&|\|\||>=|<=|==|!=|[<>+\-*/])|([(),]))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`metric math: cannot read at ${i}: ${src.slice(i)}`);
    if (m[1]) out.push({ t: 'num', v: m[1] });
    else if (m[2]) out.push({ t: 'id', v: m[2] });
    else if (m[3]) out.push({ t: 'op', v: m[3] });
    else out.push({ t: 'p', v: m[4] });
    i = re.lastIndex;
  }
  return out;
};

export const evaluate = (src: string, env: Record<string, Val>, missing: Missing): Val => {
  const toks = tokenize(src);
  let k = 0;
  const peek = () => toks[k];
  const take = (v?: string) => {
    const t = toks[k++];
    if (!t || (v !== undefined && t.v !== v)) throw new Error(`metric math: expected ${v} in ${src}`);
    return t;
  };
  const lift = (a: Val, b: Val, f: (x: number, y: number) => number): Val => {
    if (missing === 'propagate' && (a === undefined || b === undefined)) return undefined;
    return f(a ?? 0, b ?? 0);
  };
  // Lowest to highest precedence.
  const BIN: string[][] = [['||'], ['&&'], ['==', '!=', '<', '>', '<=', '>='], ['+', '-'], ['*', '/']];
  const opFn: Record<string, (x: number, y: number) => number> = {
    '||': (x, y) => (x || y ? 1 : 0), '&&': (x, y) => (x && y ? 1 : 0),
    '==': (x, y) => (x === y ? 1 : 0), '!=': (x, y) => (x !== y ? 1 : 0),
    '<': (x, y) => (x < y ? 1 : 0), '>': (x, y) => (x > y ? 1 : 0),
    '<=': (x, y) => (x <= y ? 1 : 0), '>=': (x, y) => (x >= y ? 1 : 0),
    '+': (x, y) => x + y, '-': (x, y) => x - y, '*': (x, y) => x * y, '/': (x, y) => x / y,
  };
  const level = (n: number): Val => {
    if (n === BIN.length) return unary();
    let a = level(n + 1);
    while (peek() && peek().t === 'op' && BIN[n].includes(peek().v)) {
      const op = take().v;
      a = lift(a, level(n + 1), opFn[op]);
    }
    return a;
  };
  const unary = (): Val => {
    const t = peek();
    if (t.t === 'op' && t.v === '-') { take(); const v = unary(); return v === undefined ? v : -v; }
    if (t.t === 'num') { take(); return Number(t.v); }
    if (t.t === 'p' && t.v === '(') { take('('); const v = level(0); take(')'); return v; }
    if (t.t === 'id') {
      take();
      if (t.v === 'IF') {
        take('('); const c = level(0); take(','); const a = level(0); take(','); const b = level(0); take(')');
        if (c === undefined) return missing === 'propagate' ? undefined : b;
        return c ? a : b;
      }
      if (t.v === 'FILL') {
        take('('); const m = level(0); take(','); const f = level(0); take(')');
        return m === undefined ? f : m;
      }
      if (!(t.v in env)) throw new Error(`metric math: unknown id ${t.v}`);
      return env[t.v];
    }
    throw new Error(`metric math: unexpected ${t.v}`);
  };
  const v = level(0);
  if (k !== toks.length) throw new Error(`metric math: trailing input in ${src}`);
  return v;
};

/** Would an alarm with this comparison breach on this datapoint? Missing never breaches (notBreaching). */
export const breaches = (v: Val, op: string, threshold: number) => {
  if (v === undefined) return false;
  switch (op) {
    case 'LessThanOrEqualToThreshold': return v <= threshold;
    case 'GreaterThanOrEqualToThreshold': return v >= threshold;
    case 'LessThanThreshold': return v < threshold;
    case 'GreaterThanThreshold': return v > threshold;
    default: throw new Error(`unknown comparison ${op}`);
  }
};
