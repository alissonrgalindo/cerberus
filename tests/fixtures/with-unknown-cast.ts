type User = { id: string };

export function coerce(raw: string): User {
  return raw as unknown as User;
}
