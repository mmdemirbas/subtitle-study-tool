/* The tab's sound, for a film whose page will not hand it over.
 *
 * tab-ear.js in the worker opens this document and gives it a stream id;
 * this turns the id into the tab's sound, plays it back (a captured tab is
 * taken off the speakers), hears it with the same ear the page uses, and
 * sends what it heard to the frame that has the film, stamped with the wall
 * clock so that frame can put each reading on the film's own clock.
 *
 * The readings are speech probabilities, not feature vectors: one number a
 * frame, ten frames a message. One tab at a time, because the worker asks
 * for no more. */
(() => {
  "use strict";
  const L = globalThis.__ssoListen;
  const BATCH = 10;
  const ears = new Map(); // tabId -> { frameId, ear, timer, batch }

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.target !== "offscreen") return false;
    if (message.type === "earOpen") {
      open(message).then(reply, (error) => reply({ ok: false, reason: `${error?.name || "Error"}: ${error?.message || error}` }));
      return true;
    }
    if (message.type === "earAdopt") {
      const held = ears.get(message.tabId);
      if (held) held.frameId = message.frameId;
      reply({ ok: Boolean(held), sampleRate: held?.ear.sampleRate, fftSize: held?.ear.fftSize });
      return false;
    }
    if (message.type === "earClose") {
      close(message.tabId, message.reason || "closed");
      reply({ ok: true, remaining: ears.size });
      return false;
    }
    return false;
  });

  async function open({ tabId, frameId, streamId }) {
    const already = ears.get(tabId);
    if (already) {
      already.frameId = frameId;
      return { ok: true, sampleRate: already.ear.sampleRate, fftSize: already.ear.fftSize, state: already.ear.state };
    }
    for (const other of [...ears.keys()]) close(other, "another tab", { replacing: true });
    /* The legacy constraint form, as Chrome's own tab capture samples use it:
     * no echo cancellation, gain control or noise suppression, and both
     * channels - each of the three changes the levels the detector was
     * trained on, and the side channel is half of what it reads. */
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false,
    });
    const [track] = stream.getAudioTracks();
    const context = new AudioContext();
    const ear = L.hearStream(stream, context, { playBack: true });
    const held = { frameId, ear, batch: [], timer: 0 };
    held.timer = setInterval(() => {
      const reading = ear.read();
      if (reading == null) return;
      held.batch.push([Date.now(), L.speechProbability(reading)]);
      if (held.batch.length >= BATCH) flush(tabId, held);
    }, L.HOP_MS);
    track?.addEventListener("ended", () => close(tabId, "the tab's sound ended"));
    ears.set(tabId, held);
    return { ok: true, sampleRate: ear.sampleRate, fftSize: ear.fftSize, state: context.state, settings: track?.getSettings?.() };
  }

  function flush(tabId, held) {
    const readings = held.batch;
    held.batch = [];
    chrome.runtime.sendMessage({ type: "sso:tabEarReadings", tabId, frameId: held.frameId, readings }).catch(() => {});
  }

  /* `replacing`: another tab's ear is about to open here, so the worker must
   * not read "none left" as a reason to close this document under it. */
  function close(tabId, reason, { replacing = false } = {}) {
    const held = ears.get(tabId);
    if (!held) return;
    ears.delete(tabId);
    clearInterval(held.timer);
    held.ear.close();
    const remaining = ears.size + (replacing ? 1 : 0);
    chrome.runtime.sendMessage({ type: "sso:tabEarEnded", tabId, frameId: held.frameId, reason, remaining }).catch(() => {});
  }
})();
