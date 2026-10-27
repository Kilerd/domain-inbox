/** Lower-cased domain of `name@domain`; empty string when there is no `@`. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).trim().toLowerCase() : "";
}
