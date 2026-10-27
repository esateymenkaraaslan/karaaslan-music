const $ = selector => document.querySelector(selector);
const params = new URLSearchParams(location.search);
let mode = params.get('mode') === 'register' ? 'register' : 'login';
const nextPath = (() => { const value = params.get('next') || '/'; return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/'; })();
const api = async (url, options = {}) => {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || 'İstek tamamlanamadı.'); error.status = response.status; throw error; }
  return data;
};
function renderMode() {
  const register = mode === 'register';
  document.title = `${register ? 'Hesap oluştur' : 'Giriş yap'} · Karaaslan Müzik`;
  $('#authEyebrow').textContent = register ? 'YENİ BİR HESAP' : 'KARAASLAN MÜZİK’E DÖN';
  $('#authTitle').textContent = register ? 'Kendi ritmini bul.' : 'Tekrar hoş geldin.';
  $('#authDescription').textContent = register ? 'Kısa bir kayıt ol, odanı kurmaya başla.' : 'Hesabına girip kaldığın yerden devam et.';
  $('#emailField').classList.toggle('hidden', !register);
  $('#email').required = register;
  $('#password').autocomplete = register ? 'new-password' : 'current-password';
  $('#authSubmit span').textContent = register ? 'Hesap oluştur' : 'Giriş yap';
  $('#switchPrompt').textContent = register ? 'Zaten hesabın var mı?' : 'Henüz hesabın yok mu?';
  $('#authSwitch').textContent = register ? 'Giriş yap' : 'Hesap oluştur';
  $('#authSwitch').href = `/auth.html?mode=${register ? 'login' : 'register'}&next=${encodeURIComponent(nextPath)}`;
  $('#authError').textContent = '';
}
async function continueIfSignedIn() {
  const token = localStorage.getItem('km_token') || sessionStorage.getItem('km_token');
  if (!token) return;
  try { await api('/api/me', { headers: { Authorization: `Bearer ${token}` } }); location.replace(nextPath); }
  catch (error) { if (error.status === 401) { localStorage.removeItem('km_token'); sessionStorage.removeItem('km_token'); } else $('#authError').textContent = 'Sunucu uyandırılıyor. Birkaç saniye sonra yeniden deneyebilirsin.'; }
}
$('#authSwitch').addEventListener('click', event => { event.preventDefault(); mode = mode === 'login' ? 'register' : 'login'; params.set('mode', mode); history.replaceState(null, '', `${location.pathname}?${params}`); renderMode(); $('#username').focus(); });
$('#passwordToggle').addEventListener('click', () => { const input = $('#password'); input.type = input.type === 'password' ? 'text' : 'password'; $('#passwordToggle').textContent = input.type === 'password' ? 'Göster' : 'Gizle'; });
$('#authForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget); const register = mode === 'register';
  const body = { username: String(form.get('username') || '').trim(), password: String(form.get('password') || ''), ...(register ? { email: String(form.get('email') || '').trim() } : {}) };
  const submit = $('#authSubmit'); submit.disabled = true; submit.classList.add('loading'); $('#authError').textContent = '';
  try {
    const data = await api(register ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: JSON.stringify(body) });
    if ($('#remember').checked) { localStorage.setItem('km_token', data.token); sessionStorage.removeItem('km_token'); sessionStorage.removeItem('km_remember'); }
    else { localStorage.removeItem('km_token'); sessionStorage.setItem('km_token', data.token); sessionStorage.setItem('km_remember', '0'); }
    location.assign(nextPath);
  } catch (error) { $('#authError').textContent = error.message; }
  finally { submit.disabled = false; submit.classList.remove('loading'); }
});
document.body.classList.toggle('light', localStorage.getItem('km_theme') === 'light');
renderMode(); continueIfSignedIn();
