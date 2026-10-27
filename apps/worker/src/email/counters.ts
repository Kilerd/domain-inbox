// Derived thread counters, defined once.
//
// `threads.message_count` / `unread_count` are caches over `messages`. Every
// mutation path (ingest threading, mark-read, bulk flags) used to carry its
// own copy of the subqueries; one of them forgetting `parse_status` or the
// read bit was enough to make a badge lie. Both the single-statement update
// in assignThread and the recount used by the API import these fragments.

import type { Env } from "../env";
import { FLAG_READ } from "../utils/flags";

export const THREAD_MESSAGE_COUNT_SQL =
  "(SELECT COUNT(*) FROM messages WHERE thread_id = ?1 AND parse_status != 'duplicate')";

export const THREAD_UNREAD_SQL =
  `(SELECT COUNT(*) FROM messages
    WHERE thread_id = ?1 AND parse_status != 'duplicate'
      AND (flags_bitmap & ${FLAG_READ}) = 0)`;

/** Recompute the cached counts for one thread. */
export async function recountThread(env: Env, threadId: string): Promise<void> {
  await env.DB
    .prepare(
      `UPDATE threads
       SET message_count = ${THREAD_MESSAGE_COUNT_SQL},
           unread_count  = ${THREAD_UNREAD_SQL}
       WHERE id = ?1`,
    )
    .bind(threadId)
    .run();
}
