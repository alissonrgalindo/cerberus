export function Panel({ value, mode, tags }: { value: number; mode: string; tags: string[] }) {
  let label = '';
  if (mode === 'a') {
    if (value > 0) {
      label = 'pos';
    } else {
      label = 'neg';
    }
  } else if (mode === 'b') {
    if (value > 10) {
      label = 'big';
    }
  } else {
    label = 'other';
  }
  for (const t of tags) {
    if (t.length > 3) {
      if (value > 0) {
        label += t;
      }
    }
  }
  return (
    <div>
      {label}
      {value > 0 && <span>+</span>}
      {mode === 'a' ? <b>a</b> : <i>x</i>}
    </div>
  );
}
