export type JournalTimeValue = string | null | undefined;

/** Preserve the difference between a legacy missing field and an explicit clear. */
export function readJournalTimeField(payload: Record<string, unknown>): JournalTimeValue {
  if (!Object.prototype.hasOwnProperty.call(payload, 'journalTime')) return undefined;
  return typeof payload.journalTime === 'string' ? payload.journalTime : null;
}

/** Omit an unknown legacy value so the server can inherit the formal entry time. */
export function withJournalTimeField(payload: Record<string, unknown>, journalTime: JournalTimeValue) {
  return journalTime === undefined ? payload : { ...payload, journalTime };
}
