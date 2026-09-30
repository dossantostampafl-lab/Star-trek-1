/* web/voice.js — voz da estação em português do Brasil.
   Ouvir: Web Speech API (Chrome/Edge) OU gravação + transcrição no servidor (Whisper) — funciona em qualquer
   navegador com microfone (Safari, Firefox, iPad). Falar: voz natural do servidor (Edge TTS), com a voz do
   próprio navegador como reserva. */
'use strict';
(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  let rec = null, recorder = null, audio = null, naturalFailedUntil = 0;
  const cfg = { token: '', serverStt: false, natural: true, sttReady: false };

  function configure(o) { Object.assign(cfg, o || {}); }
  const useServer = () => (cfg.serverStt && cfg.sttReady && canRecord) || (!SR && canRecord);

  function listen(onText, onState) {
    if (useServer()) return record(onText, onState);
    if (!SR) { onState && onState('unsupported'); return; }
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = 'pt-BR';
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = '';
    rec.onstart = () => onState && onState('listening');
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      onText(finalText + interim, false);
    };
    rec.onerror = (e) => onState && onState('error', e.error === 'not-allowed' ? 'permissão do microfone negada' : e.error);
    rec.onend = () => { rec = null; onState && onState('idle'); if (finalText.trim()) onText(finalText.trim(), true); };
    rec.start();
  }

  // grava até tocar de novo (máx. 60 s) e manda para o servidor transcrever
  async function record(onText, onState) {
    if (recorder) { recorder.stop(); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (_) { onState && onState('error', 'permissão do microfone negada'); return; }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    const chunks = [];
    recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const limit = setTimeout(() => recorder && recorder.state === 'recording' && recorder.stop(), 60000);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      clearTimeout(limit);
      stream.getTracks().forEach(t => t.stop());
      const mime = (recorder && recorder.mimeType) || type || 'audio/webm';
      recorder = null;
      onState && onState('working');
      try {
        const res = await fetch('/api/stt', { method: 'POST', headers: { 'x-st1-token': cfg.token, 'content-type': mime.split(';')[0] }, body: new Blob(chunks, { type: mime }) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
        onState && onState('idle');
        if (j.text) onText(j.text, true); else onState && onState('error', 'não entendi o áudio');
      } catch (e) { onState && onState('error', e.message); }
    };
    recorder.start();
    onState && onState('listening');
  }

  function pickVoice() {
    const vs = speechSynthesis.getVoices();
    return vs.find(v => v.lang === 'pt-BR' && /natural|online|google/i.test(v.name)) || vs.find(v => v.lang === 'pt-BR') || vs.find(v => /^pt/i.test(v.lang)) || null;
  }
  function browserSpeak(text) {
    if (!('speechSynthesis' in window) || !text) return;
    const clean = String(text).replace(/```[\s\S]*?```/g, ' (código omitido) ').replace(/[*_#>`]/g, '').slice(0, 1500);
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = 'pt-BR';
    const v = pickVoice();
    if (v) u.voice = v;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  async function speak(text, voice) {
    if (!text) return;
    stop();
    if (cfg.natural && Date.now() > naturalFailedUntil) {
      try {
        const res = await fetch('/api/tts', { method: 'POST', headers: { 'x-st1-token': cfg.token, 'content-type': 'application/json' }, body: JSON.stringify({ text, voice }) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const url = URL.createObjectURL(await res.blob());
        audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        await audio.play();
        return 'natural';
      } catch (_) { naturalFailedUntil = Date.now() + 5 * 60000; }
    }
    browserSpeak(text);
    return 'navegador';
  }

  function stop() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (audio) { try { audio.pause(); } catch (_) { /* ok */ } audio = null; }
    if (rec) rec.stop();
  }

  window.Voice = { canListen: !!SR || canRecord, canSpeak: true, listen, speak, stop, configure, canRecord, hasBrowserStt: !!SR };
})();
