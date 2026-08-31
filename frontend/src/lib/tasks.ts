/** Task lists inside a card body.
 *
 * The markdown source stays the single source of truth — there is no parallel
 * list of task state to drift from the text. Ticking a box rewrites the one
 * line it belongs to, which is why toggling needs the line number rather than
 * an index into the rendered output.
 */

const TASK_LINE = /^(\s*[-*+]\s+\[)([ xX])(\]\s*)/;

export interface TaskProgress {
  done: number;
  total: number;
}

export function taskProgress(body: string | null | undefined): TaskProgress {
  if (!body) return { done: 0, total: 0 };
  let done = 0;
  let total = 0;
  for (const line of body.split("\n")) {
    const match = TASK_LINE.exec(line);
    if (!match) continue;
    total += 1;
    if (match[2] !== " ") done += 1;
  }
  return { done, total };
}

/** Is the checkbox on this 1-indexed source line ticked? */
export function isTaskChecked(body: string, line: number): boolean {
  const raw = body.split("\n")[line - 1];
  if (!raw) return false;
  const match = TASK_LINE.exec(raw);
  return match ? match[2] !== " " : false;
}

/** Flip the checkbox on this 1-indexed source line. Returns the body
 * unchanged when the line is not a task, so a stale render cannot corrupt
 * the text. */
export function toggleTaskLine(body: string, line: number): string {
  const lines = body.split("\n");
  const raw = lines[line - 1];
  if (raw === undefined) return body;
  const match = TASK_LINE.exec(raw);
  if (!match) return body;
  const ticked = match[2] !== " ";
  lines[line - 1] = raw.replace(TASK_LINE, `$1${ticked ? " " : "x"}$3`);
  return lines.join("\n");
}
