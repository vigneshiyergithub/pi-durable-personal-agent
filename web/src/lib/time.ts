const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

// "5 minutes ago", "in 2 hours", "3 days ago".
export function fromNow(iso: string): string {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000)
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 36) return relative.format(hours, "hour")
  return relative.format(Math.round(hours / 24), "day")
}
