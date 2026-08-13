# The study panel does not take clicks on streaming-site.example

2026-08-08. Reported symptom: the study panel and "some other places" cannot be
clicked; the click either reaches the video player underneath or does nothing.
Tested on `https://streaming-site.example/tv/the-americans-46533?season=1&episode=9`.

## What was measured

**The video is two frames down, and cross-origin.** Walking the frame tree on
that page:

| Frame | URL | Video | Box |
|---|---|---|---|
| top | `streaming-site.example/tv/…` | 0 | 1400x813 |
| top > 0 | `streaming-site.example/watch/index.html?…` | 0 | same-origin |
| top > 0 > 0 | `embos.top/tv/?mid=46533&s=1&e=9` | **1** | cross-origin, 1136x568 at (32,120) |

The extension builds its UI in whichever frame owns the `<video>`
(`onPointerMove` → `isPageSubject(pickVideoCached())` → `ensureOverlay()`), so
the CC handle, the control panel and the study rail are all constructed inside
`embos.top` — a cross-origin iframe occupying about half the viewport.

**The page paints an interactive layer over the whole viewport.** At the time
of measurement the top document carried an `<iframe id="container-bbc894…">`
appended to `<html>` with computed `position: fixed`, `z-index: 2147483647`,
`pointer-events: auto`, sized 1200x778 — the full viewport, player box
included. `document.elementsFromPoint` returned it first at every point tested,
including over the player. Clicking there opened two popunder tabs and probe
handlers injected at those coordinates recorded zero hits.

**A nested frame cannot rise above what its parent paints over it.** Controlled
reproduction (outer page → iframe → shadow-root host promoted with
`popover="manual"` + `showPopover()`, exactly as `toTopLayer()` does):

| Parent overlay | Where the click landed |
|---|---|
| absent | the in-iframe panel button |
| `position:fixed; inset:0; z-index:2147483647` div appended to `<html>` | the parent's overlay |

The top layer is per-document. Promoting a host inside the iframe raises it
above everything in *that* document and changes nothing about where the iframe
itself sits in the parent's paint order.

For contrast, a host promoted the same way **in the top document** did out-rank
the site's ad iframe — it came back first from `elementsFromPoint`. The
mechanism is specifically about the frame boundary, not about z-index.

## What was ruled out

`revealHandle()` fires on every `pointermove` and `mousemove` and calls
`attachToCorrectParent({raise: true})`, which does `hidePopover()` +
`showPopover()` on every host — several top-layer teardowns per mouse move,
including between `mousedown` and `mouseup`. This looked like a strong
candidate for "the click is ignored". It is not: in a controlled page with the
raise loop on, a full press-move-release still delivered the `click` (1 click,
4 raises) exactly as with it off. Wasteful, not a click-eater.

## Status of the diagnosis

The frame tree, the parent-page overlay, and the platform behaviour above are
observed. What is **not** observed is the extension's own panel losing a click
on that page: the site redirected the tab on the click needed to start
playback, so the end-to-end run could not be completed with the extension
loaded. The mechanism is therefore established but the specific interceptor in
the user's own session — which very likely has an ad blocker, and so a
different set of overlays — is not.

The next step that would settle it costs seconds: with the panel on screen and
unclickable, run in the browser console of the **top** frame

```js
document.elementsFromPoint(x, y).slice(0, 5)
    .map(e => e.tagName + (e.id ? '#' + e.id : '') + ' z=' + getComputedStyle(e).zIndex)
```

at the coordinates of a panel button. Whatever comes back first is what is
taking the click.

## The shape of a fix

The interactive chrome — CC handle, control panel, study rail — has no
authority in the frame it is currently built in, and cannot be given any from
inside that frame. The cue overlay is different: it has to track the picture,
so it belongs where the video is.

That splits the extension by frame rather than by feature: cues in the video's
frame, everything interactive in the top frame, the two wired through the
background worker. `content.js` already concentrates the video-side surface
behind `window.__ssoApi`, which is the seam this would run along — `panel.js`
and `study.js` would consume a proxy over `chrome.runtime` messaging instead of
the local object.

It is a large change and it is not free of new failure modes: a message round
trip on every cue for the study rail, two clocks to keep from drifting, and the
question of which frame wins when a page has more than one video. Those want
naming before any of it is written.
