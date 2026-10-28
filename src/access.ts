export function allowedUser(allowlist: readonly string[], senderId: string): boolean {
  return senderId.length > 0 && allowlist.includes(senderId);
}
