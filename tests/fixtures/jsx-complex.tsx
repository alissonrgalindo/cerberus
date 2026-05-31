export function Dashboard({ rows, mode }: { rows: number[]; mode: string }) {
  let summary = '';
  for (const r of rows) {
    if (r > 0) {
      if (mode === 'sum') {
        if (r % 2 === 0) {
          summary += r;
        } else if (r % 3 === 0) {
          summary += r * 2;
        }
      } else if (mode === 'max') {
        if (r > 100) {
          summary = String(r);
        } else if (r > 50) {
          summary = 'mid';
        }
      }
    } else if (r < 0) {
      if (mode === 'abs') {
        if (r < -100) {
          summary += -r;
        }
      }
    }
  }
  return <div>{summary}</div>;
}
