declare function doesNotExist(): number;

export function risky(): number {
  // @ts-ignore
  const a: number = doesNotExist();
  // @ts-expect-error intentional
  const b: number = doesNotExist('bad-arg');
  return a + b;
}
