/* ElevenLabs TTS shim — overrides window.speechSynthesis so every existing
   speak() call routes through the /api/elevenlabs Vercel serverless proxy.
   The ElevenLabs API key lives only in Vercel env vars (ELEVENLABS_API_KEY).
   No keys are ever read or stored on the client. */
(function () {
  if (window.__ELEVEN_TTS_INSTALLED__) return;
  window.__ELEVEN_TTS_INSTALLED__ = true;

  var ENDPOINT = '/api/elevenlabs';
  var VOICE_ID = 'CiGXiF6vr3ULNlgVfZ5z'; // Nigerian voice
  window.ELEVEN_VOICE_ID = VOICE_ID;

  var currentAudio = null;
  var currentCtl = null;
  var cache = new Map(); // text -> objectURL
  var audioUnlocked = false;
  var pendingPlay = null; // {url, onend} retried on next gesture
  var playSeq = 0;

  function unlockAudio() {
    if (audioUnlocked) return;
    try {
      var s = new Audio();
      s.muted = true;
      s.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
      var p = s.play();
      if (p && p.then) p.then(function () { audioUnlocked = true; }).catch(function () {});
      else audioUnlocked = true;
    } catch (e) {}
  }
  ['click', 'touchstart', 'keydown', 'pointerdown'].forEach(function (ev) {
    window.addEventListener(ev, function () {
      unlockAudio();
      if (pendingPlay) {
        var pp = pendingPlay; pendingPlay = null;
        actuallyPlay(pp.url, pp.onend);
      }
    }, { capture: true, once: false });
  });

  function stop() {
    try { if (currentCtl) currentCtl.abort(); } catch (e) {}
    currentCtl = null;
    if (currentAudio) {
      try { currentAudio.pause(); } catch (e) {}
      currentAudio.src = '';
      currentAudio = null;
    }
  }

  async function fetchAudio(text) {
    if (cache.has(text)) { try { console.log('[ElevenLabs] cache hit'); } catch(e){} return cache.get(text); }
    currentCtl = new AbortController();
    try { console.log('[ElevenLabs] fetching audio for:', text.slice(0, 60) + (text.length > 60 ? '…' : '')); } catch(e){}
    var resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: text, voiceId: VOICE_ID }),
      signal: currentCtl.signal,
    });
    if (!resp.ok) {
      var detail = '';
      try { detail = await resp.text(); } catch (e) {}
      try { console.error('[ElevenLabs] fetch failed:', resp.status, detail); } catch(e){}
      throw new Error('TTS ' + resp.status + ' ' + detail);
    }
    var blob = await resp.blob();
    var url = URL.createObjectURL(blob);
    if (cache.size > 50) {
      var firstKey = cache.keys().next().value;
      try { URL.revokeObjectURL(cache.get(firstKey)); } catch (e) {}
      cache.delete(firstKey);
    }
    cache.set(text, url);
    return url;
  }

  function actuallyPlay(url, onend) {
    try { if (currentAudio) { currentAudio.pause(); currentAudio.src = ''; } } catch (e) {}
    var a = new Audio(url);
    currentAudio = a;
    // ── Signal SUCCESS to caller — onend(null) means "audio played fine"
    a.onended = function () { if (typeof onend === 'function') try { onend(null); } catch (e) {} };
    // ── Signal FAILURE — onend({error:...}) tells caller the audio could not play
    a.onerror = function () { if (typeof onend === 'function') try { onend({ error: 'audio element error' }); } catch (e) {} };
    var pr = a.play();
    if (pr && pr.catch) {
      pr.catch(function (err) {
        console.warn('[ElevenLabs] audio.play() blocked:', err && err.message || err);
        pendingPlay = { url: url, onend: onend };
        // play() rejection (autoplay block) is also a failure for the caller —
        // they may want to fall back to Web Speech which is not subject to the same gating.
        if (typeof onend === 'function') try { onend({ error: 'autoplay-blocked', blocked: true }); } catch (e) {}
      });
    }
  }

  async function play(text, onend) {
    var seq = ++playSeq;
    stop();
    try {
      var url = await fetchAudio(text);
      if (seq !== playSeq) return;
      actuallyPlay(url, onend);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.error('[ElevenLabs] TTS failed:', e && e.message || e);
      // ── Signal FAILURE to caller — they should fall back to another TTS provider
      if (typeof onend === 'function') try { onend({ error: (e && e.message) || 'TTS fetch failed' }); } catch (e2) {}
    }
  }

  // Override SpeechSynthesisUtterance to be a plain text holder
  function ShimUtter(text) {
    this.text = text || '';
    this.lang = ''; this.rate = 1; this.pitch = 1; this.volume = 1; this.voice = null;
    this.onend = null; this.onerror = null; this.onstart = null;
  }
  // ── Preserve the REAL browser speech synthesis BEFORE we replace anything ──
  // This lets callers fall back to native Web Speech when ElevenLabs fails
  // (network down, bad key, autoplay blocked on first gesture, etc.)
  window.__nativeSpeechSynth__ = window.speechSynthesis || null;
  window.__nativeUtter__ = window.SpeechSynthesisUtterance || null;

  window.SpeechSynthesisUtterance = ShimUtter;

  if (window.speechSynthesis) {
    window.speechSynthesis.speak = function (utter) {
      var t = (utter && utter.text) || '';
      if (!t) return;
      if (typeof utter.onstart === 'function') { try { utter.onstart(); } catch (e) {} }
      // Pass the err-flag through to onend; shim caller can check truthy = failure
      play(t, function(errFlag){
        if (errFlag && typeof utter.onerror === 'function') { try { utter.onerror(errFlag); } catch (e) {} }
        if (typeof utter.onend === 'function') { try { utter.onend(errFlag); } catch (e) {} }
      });
    };
    window.speechSynthesis.cancel = function () { stop(); };
    window.speechSynthesis.getVoices = function () { return []; };
  }

  window.elevenSpeak = function (text, onend) { play(String(text || ''), onend); };
  window.elevenStop = stop;
})();
