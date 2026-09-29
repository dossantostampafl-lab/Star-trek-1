'use strict';
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('go');
  const err = document.getElementById('err');
  btn.disabled = true; err.textContent = '';
  try {
    const res = await fetch('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('pw').value }) });
    const j = await res.json().catch(() => ({}));
    if (res.ok) { location.href = '/'; return; }
    err.textContent = j.error || ('erro ' + res.status);
  } catch (_) { err.textContent = 'sem conexão com a estação'; }
  btn.disabled = false;
});
