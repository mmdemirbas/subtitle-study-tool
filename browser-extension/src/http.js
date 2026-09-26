/* Let go of a response that is not going to be read.
 *
 * A fetch answered with an error status resolves like any other, and a body
 * nobody reads keeps its request open until the Response is collected - on a
 * host with a small connection pool, long enough to hold up the fetches after
 * it, which is what a playlist of subtitle segments is. Found 2026-09-26 in the
 * log's POST and then at every path that decides from the status alone; each
 * calls this before it returns or throws. */
export function letGo(response) {
  response?.body?.cancel().catch(() => {});
}
