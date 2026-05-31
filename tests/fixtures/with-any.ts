export function takesAny(input: any): any {
  const items: any[] = [];
  items.push(input);
  return items[0];
}
