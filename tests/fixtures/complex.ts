export function deeplyNested(x: number): number {
  if (x > 0) {
    if (x > 1) {
      if (x > 2) {
        if (x > 3) {
          if (x > 4) {
            if (x > 5) {
              return x;
            }
          }
        }
      }
    }
  }
  return 0;
}
