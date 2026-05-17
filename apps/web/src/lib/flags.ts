// flags_bitmap bit positions — mirror migration 0003_inbox_v2.

export const FLAG_READ = 1; // bit 0 (messages-only)
export const FLAG_STARRED = 2; // bit 1
export const FLAG_ARCHIVED = 4; // bit 2
export const FLAG_TRASH = 8; // bit 3
export const FLAG_SPAM = 16; // bit 4
export const FLAG_MUTED = 32; // bit 5 (reserved)

export function has(bitmap: number, flag: number): boolean {
  return (bitmap & flag) !== 0;
}
