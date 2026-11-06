// ==UserScript==
// @name         Nepal Gov Autofill – Passport Register
// @namespace    roughdev
// @version      7.1
// @description  Scan NID front with AI (via Nepal Gov Autofill server) -> auto-fill name/DOB/NIN, guided step-by-step with Nepali voice prompts, double confirmation, auto password, auto-filled login, printable slip. Captcha + Register stay manual.
// @match        https://online.nepalpassport.gov.np/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      nepal-gov-autofill.tamang-subash36.workers.dev
// @updateURL    https://raw.githubusercontent.com/Moktan-26/nepal-gov-autofill/main/nepal-gov-autofill.user.js
// @downloadURL  https://raw.githubusercontent.com/Moktan-26/nepal-gov-autofill/main/nepal-gov-autofill.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------- CONFIG ----------
  const CONFIG = {
    fallbackEmail: '',          // optional fallback email if the person has none (e.g. a family member's)
    smsEndpoint: '',            // your SMS backend URL: POST {phone, message}. Empty = no SMS, just print slip
    scanServer: 'https://nepal-gov-autofill.tamang-subash36.workers.dev/scan',  // reads the NID card (holds the AI key)
  };

  // Status line in whichever panel is open (set when a panel is built)
  let msg = () => {};

  // ---------- VOICE (spoken prompts only; no voice input) ----------
  // Chrome loads its voice list a moment after page load, so wait for it once.
  let voicePromise = null;
  function getVoice() {
    voicePromise = voicePromise || new Promise(r => {
      const pick = () => {
        const v = speechSynthesis.getVoices();
        return v.find(x => /^ne/i.test(x.lang))
          || v.find(x => /^hi/i.test(x.lang) && /google/i.test(x.name))
          || v.find(x => /^hi/i.test(x.lang)) || null;
      };
      if (speechSynthesis.getVoices().length) return r(pick());
      speechSynthesis.addEventListener('voiceschanged', () => r(pick()), { once: true });
      setTimeout(() => r(pick()), 3000);
    });
    return voicePromise;
  }
  let lastSaid = '';
  async function say(text) {
    lastSaid = text;
    try {
      const voice = await getVoice();
      if (!voice) { msg('🔇 No Nepali/Hindi voice on this device — read the instructions on screen.'); return; }
      speechSynthesis.cancel();
      await new Promise(r => setTimeout(r, 100));   // Chrome drops speech that starts right after cancel()
      const u = new SpeechSynthesisUtterance(text);
      u.voice = voice; u.lang = voice.lang; u.rate = 0.9;
      speechSynthesis.speak(u);
    } catch (e) { /* speech is a bonus; never break the form */ }
  }

  // ---------- CARD READING (your server holds the AI key; nothing is stored) ----------
  function post(url, body) {
    return new Promise((res, rej) => GM_xmlhttpRequest({
      method: 'POST', url, data: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      onload: r => {
        let j = {}; try { j = JSON.parse(r.responseText); } catch {}
        r.status >= 200 && r.status < 300 ? res(j) : rej(new Error(j.error || 'Server error ' + r.status));
      },
      onerror: () => rej(new Error('No internet or server unreachable')),
    }));
  }

  // Shrink photo to max 1600px JPEG (faster upload, still sharp enough)
  async function toJpegBase64(file) {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);            // photo not kept
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }

  async function readCard(file) {
    msg('Preparing photo…');
    const b64 = await toJpegBase64(file);
    msg('Reading card…');
    const d = await post(CONFIG.scanServer, { image: b64 });
    // sanity checks so a bad read never slips through
    const out = {
      given: String(d.given || '').trim(),
      surname: String(d.surname || '').trim(),
      dob: /^\d{4}-\d{2}-\d{2}$/.test(d.dob || '') ? d.dob : '',
      nin: String(d.nin || '').replace(/\D/g, ''),
    };
    if (out.nin.length !== 10) out.nin = '';
    if (out.dob && +out.dob.slice(0, 4) > new Date().getFullYear() - 16) out.dob = '';
    return out;
  }

  // ---------- FORM ----------
  function setVal(sel, val) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    document.querySelectorAll(sel).forEach(el => {
      el.focus(); set.call(el, val);
      ['input', 'change', 'keyup', 'blur'].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
    });
  }

  function genPassword() {
    const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '@#$%&*!'];
    const r = n => crypto.getRandomValues(new Uint32Array(1))[0] % n;
    let p = sets.map(s => s[r(s.length)]);
    const all = sets.join('');
    while (p.length < 10) p.push(all[r(all.length)]);
    return p.sort(() => r(3) - 1).join('');
  }

  function printSlip(d) {
    const w = window.open('', '_blank', 'width=420,height=520');
    if (!w) return msg('Allow pop-ups to print the slip.');
    w.document.write(`<body style="font:20px sans-serif;padding:20px">
      <h2>राहदानी खाता / Passport Account</h2>
      <p><b>नाम:</b> ${d.given} ${d.surname}</p>
      <p><b>Username (Email):</b><br>${d.email}</p>
      <p><b>Password:</b><br><span style="font:28px monospace;letter-spacing:2px">${d.pass}</span></p>
      <p style="font-size:14px">यो कागज सुरक्षित राख्नुहोस्। Keep this slip safe.</p>
      <script>print()<\/script></body>`);
  }

  async function sendSMS(phone, text) {
    if (!CONFIG.smsEndpoint) return false;
    try {
      const r = await fetch(CONFIG.smsEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, message: text }) });
      return r.ok;
    } catch { return false; }
  }

  // ---------- FIELDS: what each needs, how to check it, what to say ----------
  const FIELDS = [
    { k: 'given',   label: 'Given name / नाम',         ne: 'कृपया आफ्नो नाम लेख्नुहोस्।',            en: 'Please enter your given name',
      ok: v => /^[A-Za-z][A-Za-z .'-]*$/.test(v), bad: 'Use English letters only' },
    { k: 'surname', label: 'Surname / थर',             ne: 'कृपया आफ्नो थर लेख्नुहोस्।',              en: 'Please enter your surname',
      ok: v => /^[A-Za-z][A-Za-z .'-]*$/.test(v), bad: 'Use English letters only' },
    { k: 'dob',     label: 'DOB (AD) / जन्म मिति',      ne: 'कृपया जन्म मिति ईस्वी सम्वतमा लेख्नुहोस्।', en: 'Please enter date of birth in AD, like 2000-01-13',
      ok: v => /^\d{4}-\d{2}-\d{2}$/.test(v) && +v.slice(0, 4) >= 1920 && +v.slice(0, 4) <= new Date().getFullYear() - 16, bad: 'Format: YYYY-MM-DD (AD)' },
    { k: 'nin',     label: 'NIN / राष्ट्रिय परिचय नं.',   ne: 'कृपया राष्ट्रिय परिचय नम्बर लेख्नुहोस्।',   en: 'Please enter your NIN (10 digits)',
      ok: v => /^\d{10}$/.test(v.replace(/\D/g, '')), bad: 'NIN must be 10 digits' },
    { k: 'phone',   label: 'Mobile / मोबाइल नम्बर',     ne: 'कृपया आफ्नो मोबाइल नम्बर लेख्नुहोस्।',     en: 'Please enter your mobile number (98XXXXXXXX)',
      ok: v => /^9[678]\d{8}$/.test(v.replace(/\D/g, '').replace(/^977/, '')), bad: 'Mobile must be 10 digits starting 96/97/98' },
    { k: 'email',   label: 'Email / इमेल',              ne: 'कृपया आफ्नो इमेल लेख्नुहोस्।',            en: 'Please enter your email address',
      ok: v => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v), bad: 'Check the email (example: name@gmail.com)' },
  ];

  // ---------- REGISTER PAGE UI ----------
  let regBox = null;
  function buildRegister() {
  const box = document.createElement('div');
  box.id = 'k-reg-panel';
  regBox = box;
  box.style.cssText = 'position:fixed;top:70px;right:16px;z-index:99999;background:#fff;border:3px solid #c8102e;border-radius:12px;padding:14px;width:310px;max-height:85vh;overflow:auto;font:15px sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.25)';
  box.innerHTML = `
    <b style="color:#c8102e;font-size:17px">🪪 Nepal Gov Autofill</b>
    <div id="k-ask" title="Tap to hear again" style="margin-top:8px;padding:10px;border-radius:8px;background:#fff4e5;font-size:16px;font-weight:bold;cursor:pointer"></div>
    <div style="font-size:11px;color:#888;margin-top:2px">🔊 Tap the instruction to hear it again / फेरि सुन्न थिच्नुहोस्</div>
    <label id="k-scan" style="display:block;margin-top:8px;padding:14px;background:#c8102e;color:#fff;text-align:center;border-radius:8px;cursor:pointer;font-size:17px">
      📷 NID कार्ड स्क्यान / Scan NID<input id="k-img" type="file" accept="image/*" capture="environment" hidden></label>
    <div id="k-fields" style="margin-top:6px"></div>
    <button id="k-next" style="width:100%;margin-top:10px;padding:12px;font-size:16px;border-radius:8px;border:0;background:#1a7f37;color:#fff">अर्को / Next ➜</button>
    <div id="k-review" style="display:none"></div>
    <div id="k-msg" style="margin-top:8px;font-size:13px;color:#555"></div>`;
  document.body.appendChild(box);

  const $ = q => box.querySelector(q);
  msg = t => ($('#k-msg').textContent = t);
  const ask = (t, color = '#fff4e5') => { $('#k-ask').textContent = t; $('#k-ask').style.background = color; };
  const input = k => $('#k-' + k);
  $('#k-ask').onclick = () => lastSaid && say(lastSaid);
  const val = k => input(k).value.trim();

  FIELDS.forEach(f => {
    const wrap = document.createElement('div');
    wrap.style.marginTop = '6px';
    wrap.innerHTML = `<div style="font-size:12px;color:#555">${f.label}</div>
      <input id="k-${f.k}" style="width:100%;box-sizing:border-box;padding:8px;border:2px solid #ccc;border-radius:6px;font-size:16px">
      <div id="k-${f.k}-err" style="font-size:12px;color:#c8102e"></div>`;
    $('#k-fields').appendChild(wrap);
  });
  input('phone').inputMode = 'numeric'; input('nin').inputMode = 'numeric';
  input('email').type = 'email'; input('email').value = CONFIG.fallbackEmail;

  const mark = (k, state) => {               // '', 'ok', 'need', 'bad'
    const el = input(k);
    el.style.borderColor = { ok: '#1a7f37', need: '#e69500', bad: '#c8102e' }[state] || '#ccc';
    el.style.background = state === 'need' ? '#fffbe6' : '#fff';
  };

  // Find the first field that is empty or wrong, point at it, say what to do
  async function guide() {
    for (const f of FIELDS) {
      const v = val(f.k);
      const err = $('#k-' + f.k + '-err');
      if (!v || !f.ok(v)) {
        FIELDS.forEach(g => g.k !== f.k && val(g.k) && g.ok(val(g.k)) && mark(g.k, 'ok'));
        mark(f.k, v ? 'bad' : 'need');
        err.textContent = v ? f.bad : '';
        ask('👉 ' + f.en + ' / ' + f.ne);
        input(f.k).scrollIntoView({ block: 'center' });
        input(f.k).focus();
        say(f.ne);
        return false;
      }
      err.textContent = ''; mark(f.k, 'ok');
    }
    return true;
  }

  // Live check as the user types
  FIELDS.forEach(f => input(f.k).addEventListener('input', () => {
    const v = val(f.k);
    mark(f.k, !v ? 'need' : f.ok(v) ? 'ok' : 'bad');
    $('#k-' + f.k + '-err').textContent = v && !f.ok(v) ? f.bad : '';
  }));
  // Move on by itself: when a field becomes valid and the user stops typing, go to the next step
  let advanceTimer = null;
  const advance = async () => { if (await guide()) review(); };
  FIELDS.forEach(f => {
    input(f.k).addEventListener('input', () => {
      clearTimeout(advanceTimer);
      const v = val(f.k);
      if (!v || !f.ok(v)) return;
      const wait = f.k === 'phone' || f.k === 'nin' ? 300 : 1500;   // numbers are complete when valid; text needs a pause
      advanceTimer = setTimeout(() => { if (f.ok(val(f.k))) advance(); }, wait);
    });
    input(f.k).addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(advanceTimer); advance(); } });
  });

  // ---------- STEP 1: scan ----------
  getVoice();
  ask('👉 Scan the front of your NID card / राष्ट्रिय परिचयपत्रको अगाडिको फोटो खिच्नुहोस्');
  setTimeout(() => say('नमस्ते। कृपया आफ्नो राष्ट्रिय परिचयपत्रको अगाडिको फोटो खिच्नुहोस्।'), 800);

  $('#k-img').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    e.target.value = '';
    ask('⏳ Reading card… / कार्ड पढ्दै…');
    try {
      const d = await readCard(file);
      ['given', 'surname', 'dob', 'nin'].forEach(k => { if (d[k]) input(k).value = d[k]; });
      const got = ['given', 'surname', 'dob', 'nin'].filter(k => d[k]).length;
      msg(got === 4 ? '✔ Card read. Check each field against the card.' : `Read ${got} of 4 details from the card.`);
      if (got === 0) { ask('⚠ Could not read the card. Retake the photo (flat, good light) or type the details. / फेरि फोटो खिच्नुहोस्', '#ffe5e5'); say('कार्ड पढ्न सकिएन। फेरि फोटो खिच्नुहोस्।'); return; }
      await guide();
    } catch (err) { ask('❌ ' + err.message, '#ffe5e5'); }
  };

  // ---------- STEP 2: fill missing fields one by one ----------
  $('#k-next').onclick = () => { clearTimeout(advanceTimer); advance(); };

  // ---------- STEP 3: confirmation 1 — review everything before filling ----------
  function review() {
    const d = Object.fromEntries(FIELDS.map(f => [f.k, val(f.k)]));
    d.nin = d.nin.replace(/\D/g, '');
    d.phone = d.phone.replace(/\D/g, '').replace(/^977/, '');
    d.email = d.email.toLowerCase();
    const row = (l, v) => `<tr><td style="color:#555;padding:4px 6px 4px 0;font-size:13px">${l}</td><td style="font-weight:bold;font-size:16px;word-break:break-all">${v}</td></tr>`;
    $('#k-fields').style.display = 'none'; $('#k-next').style.display = 'none'; $('#k-scan').style.display = 'none';
    $('#k-review').style.display = 'block';
    $('#k-review').innerHTML = `<table style="width:100%;margin-top:8px;border-collapse:collapse">
        ${row('Name / नाम', d.given + ' ' + d.surname)}${row('DOB (AD)', d.dob)}${row('NIN', d.nin)}
        ${row('Mobile', '+977 ' + d.phone)}${row('Email', d.email)}</table>
      <button id="k-yes" style="width:100%;margin-top:10px;padding:12px;font-size:16px;border-radius:8px;border:0;background:#1a7f37;color:#fff">✅ सबै सही छ / All correct — fill form</button>
      <button id="k-edit" style="width:100%;margin-top:6px;padding:10px;font-size:15px;border-radius:8px;border:1px solid #999;background:#fff">✏️ सच्याउनुहोस् / Edit</button>`;
    ask('👉 Check all details carefully / सबै विवरण ध्यानले जाँच्नुहोस्');
    say(`कृपया जाँच्नुहोस्। नाम ${d.given} ${d.surname}। जन्म मिति ${d.dob.split('-').join(' ')}। मोबाइल ${d.phone.split('').join(' ')}। सबै सही छ भने हरियो बटन थिच्नुहोस्।`);
    $('#k-edit').onclick = backToEdit;
    $('#k-yes').onclick = () => fillForm(d);
  }

  function backToEdit() {
    $('#k-review').style.display = 'none';
    $('#k-fields').style.display = 'block'; $('#k-next').style.display = 'block'; $('#k-scan').style.display = 'block';
    ask('✏️ Fix the details, then press Next / सच्याएर Next थिच्नुहोस्');
  }

  // ---------- STEP 4: fill the real form, then confirmation 2 on the form itself ----------
  async function fillForm(d) {
    d.pass = genPassword();
    setVal('#entityName', d.given);
    setVal('#entitySurname', d.surname);
    setVal('[name="entityDateOfBirth"]', d.dob);
    setVal('#entityId', d.nin);
    setVal('#email', d.email);
    setVal('#phone', '+977' + d.phone);
    setVal('[name="password"],[name="repeatPassword"]', d.pass);

    // check the page actually kept every value
    const want = { '#entityName': d.given, '#entitySurname': d.surname, '[name="entityDateOfBirth"]': d.dob,
      '#entityId': d.nin, '#email': d.email, '#phone': '+977' + d.phone };
    const missed = Object.entries(want).filter(([q, v]) => (document.querySelector(q)?.value || '').trim() !== v);

    GM_setValue('pendingLogin', { email: d.email, pass: d.pass, t: Date.now() });   // for the login page; auto-deleted
    const sent = await sendSMS(d.phone, `Passport portal login. Username: ${d.email} Password: ${d.pass}`);
    $('#k-review').innerHTML = `<div style="margin-top:8px;padding:10px;border:2px dashed #1a7f37;border-radius:8px">
        <div style="font-size:13px">Password / पासवर्ड:</div>
        <div style="font:22px monospace;letter-spacing:2px;margin:4px 0">${d.pass}</div>
        <div style="font-size:12px;color:#555">${sent ? 'Sent by SMS.' : 'Printed on the slip.'} Keep it safe.</div></div>
      <button id="k-ok2" style="width:100%;margin-top:10px;padding:12px;font-size:16px;border-radius:8px;border:0;background:#1a7f37;color:#fff">✅ फारम सही छ / The form is correct</button>
      <button id="k-edit2" style="width:100%;margin-top:6px;padding:10px;font-size:15px;border-radius:8px;border:1px solid #999;background:#fff">✏️ सच्याउनुहोस् / Edit</button>`;
    printSlip(d);
    if (missed.length) ask('⚠ Some fields did not fill. Check the form on the left and fix them there. / केही खाली छ, बायाँको फारम जाँच्नुहोस्', '#ffe5e5');
    else ask('👉 Look at the form on the left: is everything correct? / बायाँको फारम सही छ?');
    say('फारम भरियो। कृपया बायाँको फारम फेरि जाँच्नुहोस्।');
    $('#k-edit2').onclick = backToEdit;
    $('#k-ok2').onclick = () => {
      $('#k-review').innerHTML = '';
      ask('✔ Now type the captcha and click Register / अब क्याप्चा लेखेर Register थिच्नुहोस्', '#e6f4ea');
      say('अब क्याप्चा लेखेर रजिस्टर थिच्नुहोस्।');
      const cap = document.querySelector('#captcha');
      if (cap) { cap.scrollIntoView({ block: 'center' }); cap.focus(); }
    };
  }
  }

  // ---------- LOGIN PAGE: fill email + password by itself ----------
  const PENDING_MS = 30 * 60 * 1000;          // remember the new login for 30 minutes at most
  function pendingLogin() {
    const p = GM_getValue('pendingLogin', null);
    if (p && Date.now() - p.t < PENDING_MS) return p;
    if (p) GM_deleteValue('pendingLogin');
    return null;
  }
  const waitFor = (q, ms = 10000) => new Promise(res => {
    const t0 = Date.now();
    (function poll() {
      const el = document.querySelector(q);
      if (el) return res(el);
      if (Date.now() - t0 > ms) return res(null);
      setTimeout(poll, 250);
    })();
  });

  let loginBox = null, filledLogin = false;
  async function fillLogin() {
    const p = pendingLogin();
    const user = await waitFor('#username');
    if (!user || !location.pathname.toLowerCase().startsWith('/account/login')) return;
    loginBox = document.createElement('div');
    loginBox.style.cssText = 'position:fixed;top:70px;right:16px;z-index:99999;background:#fff;border:3px solid #c8102e;border-radius:12px;padding:14px;width:300px;font:16px sans-serif;font-weight:bold;box-shadow:0 4px 18px rgba(0,0,0,.25)';
    document.body.appendChild(loginBox);
    if (!p) {
      loginBox.innerHTML = '🪪 Nepal Gov Autofill<div style="margin-top:8px;font-weight:normal;font-size:14px">Type the email and password from your slip, then the captcha. / स्लिपको इमेल र पासवर्ड लेख्नुहोस्।</div>';
      return;
    }
    setVal('#username', p.email);
    setVal('[name="password"]', p.pass);
    filledLogin = true;
    const cap = document.querySelector('#captcha');
    if (cap) { cap.scrollIntoView({ block: 'center' }); cap.focus(); }
    loginBox.innerHTML = '🪪 Nepal Gov Autofill<div style="margin-top:8px;padding:10px;border-radius:8px;background:#e6f4ea">✔ Email & password filled.<br>👉 Type the captcha and click Sign in<br>अब क्याप्चा लेखेर Sign in थिच्नुहोस्</div>';
    say('इमेल र पासवर्ड भरियो। अब क्याप्चा लेखेर साइन इन थिच्नुहोस्।');
  }

  // ---------- ROUTER: the site changes pages without reloading, so watch the address ----------
  let currentPath = '';
  function route() {
    const path = location.pathname.toLowerCase();
    if (path === currentPath) return;
    const prev = currentPath; currentPath = path;
    if (loginBox) { loginBox.remove(); loginBox = null; }
    if (regBox) regBox.style.display = path.startsWith('/account/register') ? 'block' : 'none';
    // left the login page after we filled it -> logged in (or gave up): forget the password
    if (prev.startsWith('/account/login') && !path.startsWith('/account/login') && filledLogin) {
      GM_deleteValue('pendingLogin'); filledLogin = false;
    }
    if (path.startsWith('/account/register') && !regBox) waitFor('#entityName').then(el => el && !regBox && buildRegister());
    if (path.startsWith('/account/login')) fillLogin();
  }
  pendingLogin();                             // drop anything older than 30 minutes
  route();
  setInterval(route, 500);
})();
