/* web/voice.js — voz pelo próprio navegador, em português do Brasil.
   Ouvir: Web Speech API (Chrome e Edge; no Firefox não existe). Falar: speechSynthesis (todos os navegadores). */
'use strict';
(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;

  function listen(onText, onState) {
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

  function pickVoice() {
    const vs = speechSynthesis.getVoices();
    return vs.find(v => v.lang === 'pt-BR' && /natural|online|google/i.test(v.name)) || vs.find(v => v.lang === 'pt-BR') || vs.find(v => /^pt/i.test(v.lang)) || null;
  }

  function speak(text) {
    if (!('speechSynthesis' in window) || !text) return;
    const clean = String(text).replace(/```[\s\S]*?```/g, ' (código omitido) ').replace(/[*_#>`]/g, '').slice(0, 1500);
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = 'pt-BR';
    const v = pickVoice();
    if (v) u.voice = v;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  function stop() { if ('speechSynthesis' in window) speechSynthesis.cancel(); if (rec) rec.stop(); }

  window.Voice = { canListen: !!SR, canSpeak: 'speechSynthesis' in window, listen, speak, stop };
})();
