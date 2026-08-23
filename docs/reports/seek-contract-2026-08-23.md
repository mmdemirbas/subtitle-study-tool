# Asking a page to seek: what the movies app has to add

**For the session working in `~/dev/mmdemirbas/movies`.** Everything below was
measured on 2026-08-23 against that app running on `localhost:5173`, playing
`tt4331672` (The Americans S03E09, "Stingers") from
`/path/to/The Americans S03`.
The extension side is already done and committed; this is the other half.

## What the reader sees

The subtitle overlay binds **T** to "say that line again" and **Y** to "next
line". On the local player, T threw the picture a long way back instead of to
the line before, and the jump got bigger the longer the film had been playing.
Y jumped backwards too. Reported as "T jumps too much previous subtitle
positions".

## Why, exactly

The extension steps a line by writing `video.currentTime`. On a `remux` file
that write does nothing, and the element says it did something.

Measured with Playwright against the real page, after the app had re-opened the
stream (`data-sso-time-offset` = 1014.034):

| Write asked for | Read back immediately | Events fired | Where it settled |
|---|---|---|---|
| 2.52s - backwards, inside `buffered` | **0** | `seeking`, `seeked` | element 2.24 |
| 28.75s - forwards, past `buffered` | **0** | `seeking`, `seeked` | element 2.23 |
| -56.26s - backwards, past zero | **0** | `seeking`, `seeked` | element 2.24 |

Throughout: `seekable` was the single empty range `[0, 0]`, `buffered` was
`[0.08, 8.02]`, `readyState` 4, playing. This is the same thing
`applyPendingSeek` in `local-player.svelte` already records ("`currentTime = 4.9`
came back 0 with a `seeked` event to say it had happened") - it is not new
behaviour, it is that nothing outside the app knew about it.

So every T and Y press landed the film at `offset + 2.2s`: the start of the
stream the app had last opened. Watch for ten minutes without touching the app's
own controls and T throws you ten minutes back. On a `direct` file none of this
happens and both keys have always worked.

## Why the app is the only thing that can fix it

A stream produced as it is sent cannot be seeked by the element at all. The only
way to reach another moment is to fetch a new stream that begins there, and the
app is the only party that can do that - `seekTo` already does it. The gap is
that nothing outside the app can reach `seekTo`.

The existing contract carries the film's clock in one direction only:
`data-sso-time-offset` lets the extension READ where the stream starts. It is
not broken and does not change. What it lacks is the other direction.

## What to add

Two things on the element that already carries the offset (line 1986 of
`src/lib/components/local-player.svelte`).

**1. Say that asks are accepted:**

```svelte
<video
  data-sso-time-offset={offset}
  data-sso-seek="film"
  ...
>
```

**2. Answer them.** The moment arrives as a string on the element, in **film**
seconds - the same clock `data-sso-time-offset` is on, not the element's:

```ts
// Anything outside the page can ask for a moment of the film. A stream
// produced as it is sent cannot be seeked by writing currentTime - the write
// comes back as 0 - so the ask has to reach seekTo, which re-opens the stream.
function onOutsideSeek() {
  if (!video) return;
  const seconds = Number(video.dataset.ssoSeekTo);
  if (!Number.isFinite(seconds) || seconds < 0) return;
  seekTo(seconds, 'before');
}
```

bound with `onsso:seek={onOutsideSeek}` on the `<video>` (or
`video.addEventListener('sso:seek', onOutsideSeek)` where the element is bound -
the event bubbles, so `<svelte:window>` works too).

**3. Land at or before, not nearest.** `seekTo` currently passes `'nearest'` to
`attach`. For a line repeat that is the wrong side: `nearestStart` is 1.53s out
on average and 2.25s at worst but **can land after** the moment asked for, which
clips the first word off the line the reader wanted repeated. `trueStart` is
2.96s early on average and 5.61s at worst and never overshoots, which for this
purpose is only ever "you hear a little of the line before". So the ask needs
`landing: 'before'` - the default `attach` already has - rather than the
`'nearest'` that a scrubber drag wants:

```ts
function seekTo(seconds: number, landing: 'before' | 'nearest' = 'nearest') {
  if (!file) return;
  const target = Math.max(0, Math.min(seconds, duration || seconds));
  if (!started) { attach(target, true, null, landing); return; }
  if (file.tier === 'remux') {
    void attach(target, !paused, null, landing);
  } else if (video) {
    video.currentTime = target;
  }
}
```

Every existing caller keeps `'nearest'` by not passing anything.

## What the extension does with it

`seekFilm` in `browser-extension/src/content.js` is now the only place that
moves the film. Given `data-sso-seek="film"` it writes
`video.dataset.ssoSeekTo` and dispatches `new Event("sso:seek", { bubbles: true })`
on the video, and never touches `currentTime`. Without it, it writes
`currentTime` as before and reads it straight back; a write that does not take
now tells the reader "This player will not jump - the film stayed where it was"
instead of silently throwing the picture backwards.

A string on the element rather than a `CustomEvent` detail is deliberate: an
object built in an extension's isolated world is not reliably readable in the
page's, and the DOM is the one thing both worlds share. That much was executed
rather than assumed - a content script in a real loaded extension wrote
`dataset.ssoSeekTo = "42.000"` and dispatched the bubbling event, and a listener
in the page's own world read back `42.000` from the attribute and saw the event
reach `document`. Any other party can implement the same two lines.

## How to check it worked

1. Open `localhost:5173/title/tt4331672`, start playing, let it run a minute.
2. In the console: `const v = document.querySelector('video');
   v.dataset.ssoSeekTo = String(Number(v.dataset.ssoTimeOffset) + 30);
   v.dispatchEvent(new Event('sso:seek', { bubbles: true }))`.
3. The picture should move to about 30s past where the stream started, and
   `data-sso-time-offset` should be re-stated at the new keyframe, at or before
   what was asked for. `video.currentTime` restarts near zero, as it does for
   any seek on this tier.
4. With the extension installed and two subtitles attached, T should repeat the
   line being spoken and a second press should reach the line before it.

`browser-extension/tools/probe-seek.mjs` asks the same question without the
extension and prints the answer:

```
PLAYWRIGHT_PATH=/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules \
  node tools/probe-seek.mjs http://localhost:5173/title/tt4331672
```

Today it ends `VERDICT the element refuses and the page says nothing - this page
needs data-sso-seek`. After the change it should say the page takes asks.

## What not to change

- `data-sso-time-offset` keeps its meaning exactly. The extension reads it every
  tick and everything on screen is on the film's clock.
- Nothing about `direct` files. They seek by element write and always have.
- The extension asks for a moment; it never asks for a stream, a tier, or a
  keyframe. Which stream serves the moment is the app's business.
