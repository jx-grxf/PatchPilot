/**
 * A compact unified-style diff for the transcript: changed lines with one line
 * of context, hunks separated by "@@". Not a patch format; it only has to read
 * well after an edit, so it is bounded and gives up on huge inputs.
 */
export function compactDiff(before: string, after: string, options: { maxLines?: number; context?: number } = {}): string {
  const maxLines = options.maxLines ?? 24;
  const context = options.context ?? 1;
  const left = before === "" ? [] : before.split(/\r?\n/);
  const right = after.split(/\r?\n/);

  if (left.length === 0) {
    const shown = right.slice(0, maxLines).map((line) => `+${line}`);
    return right.length > maxLines ? [...shown, `@@ ${right.length - maxLines} more lines`].join("\n") : shown.join("\n");
  }

  // Trim the shared head and tail first: an edit touches a small middle, and
  // the quadratic step below then only sees that middle.
  let head = 0;
  while (head < left.length && head < right.length && left[head] === right[head]) {
    head += 1;
  }
  let tail = 0;
  while (tail < left.length - head && tail < right.length - head && left[left.length - 1 - tail] === right[right.length - 1 - tail]) {
    tail += 1;
  }
  const oldMid = left.slice(head, left.length - tail);
  const newMid = right.slice(head, right.length - tail);

  const ops = oldMid.length * newMid.length > 250_000 ? replaceAll(oldMid, newMid) : lcsOps(oldMid, newMid);
  const rows: string[] = [];
  for (let index = Math.max(0, head - context); index < head; index += 1) {
    rows.push(` ${left[index]}`);
  }
  rows.push(...collapseContext(ops, context));
  for (let index = left.length - tail; index < Math.min(left.length, left.length - tail + context); index += 1) {
    rows.push(` ${left[index]}`);
  }

  return rows.length > maxLines ? [...rows.slice(0, maxLines), `@@ ${rows.length - maxLines} more lines`].join("\n") : rows.join("\n");
}

type Op = { kind: " " | "-" | "+"; text: string };

function replaceAll(oldLines: string[], newLines: string[]): Op[] {
  return [...oldLines.map((text): Op => ({ kind: "-", text })), ...newLines.map((text): Op => ({ kind: "+", text }))];
}

function lcsOps(a: string[], b: string[]): Op[] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: "-", text: a[i]! });
      i += 1;
    } else {
      ops.push({ kind: "+", text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) {
    ops.push({ kind: "-", text: a[i++]! });
  }
  while (j < b.length) {
    ops.push({ kind: "+", text: b[j++]! });
  }
  return ops;
}

/** Long unchanged runs inside the middle shrink to their edges and a marker. */
function collapseContext(ops: Op[], context: number): string[] {
  const rows: string[] = [];
  let index = 0;
  while (index < ops.length) {
    const op = ops[index]!;
    if (op.kind !== " ") {
      rows.push(`${op.kind}${op.text}`);
      index += 1;
      continue;
    }
    let end = index;
    while (end < ops.length && ops[end]!.kind === " ") {
      end += 1;
    }
    const run = ops.slice(index, end);
    if (run.length > context * 2 + 1) {
      rows.push(...run.slice(0, context).map((entry) => ` ${entry.text}`), "@@", ...run.slice(-context).map((entry) => ` ${entry.text}`));
    } else {
      rows.push(...run.map((entry) => ` ${entry.text}`));
    }
    index = end;
  }
  return rows;
}
