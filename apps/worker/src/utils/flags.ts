// flags_bitmap bit positions — mirror migration 0003_inbox_v2 and the SPA's
// lib/flags.ts. Keep this module the only definition on the worker side.

export const FLAG_READ = 1; // bit 0 (messages-only)
export const FLAG_STARRED = 2; // bit 1
export const FLAG_ARCHIVED = 4; // bit 2
export const FLAG_TRASH = 8; // bit 3
export const FLAG_SPAM = 16; // bit 4
// Bit 5 is reserved by the SPA (`FLAG_MUTED`); do not reuse it.
// Bit 6: the message is a DSN/ARF report, not correspondence. It stays in the
// thread (and its unread count) but must not inflate alias badges.
export const FLAG_AUXILIARY = 64;
