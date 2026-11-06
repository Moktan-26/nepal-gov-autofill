// ==UserScript==
// @name         Nepal Gov Autofill – Passport Register
// @namespace    https://github.com/Moktan-26/nepal-gov-autofill
// @version      8.8
// @description  Scan NID front with AI (via Nepal Gov Autofill server) -> auto-fill name/DOB/NIN, guided step-by-step with Nepali voice prompts, double confirmation, auto password, auto-filled login, opens Apply for a document after sign-in, picks New + 34 pages + Kathmandu office, fills phone + email from the account, auto Next after choosing a time slot, citizenship certificate scan on the Demographic step, auto-uploads NID + citizenship on Supporting documents, auto Next on completed steps, printable slip. Captcha + Register stay manual.
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
    // Application defaults (change here if needed)
    appType: /first issuance/i,              // First issuance (New)
    passportType: /ordinary 34 pages/i,      // Ordinary 34 pages
    province: /^bagmati/i,
    district: /^kathmandu/i,
    office: /^department of passports/i,
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
    savePhotos('nid', [b64]);                // kept briefly for the Supporting documents step
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
    if (!path.startsWith('/application/')) clearToast();
    if (regBox) regBox.style.display = path.startsWith('/account/register') ? 'block' : 'none';
    // left the login page after we filled it -> logged in (or gave up): forget the password
    if (prev.startsWith('/account/login') && !path.startsWith('/account/login') && filledLogin) {
      GM_deleteValue('pendingLogin'); filledLogin = false;
    }
    if (path.startsWith('/account/register') && !regBox) waitFor('#entityName').then(el => el && !regBox && buildRegister());
    if (path.startsWith('/account/login')) { GM_setValue('loginSeenAt', Date.now()); fillLogin(); }
    if (path === '/' || path === '/home') openApplyAfterLogin();
    if (path.startsWith('/application/pre-enrollment-home')) chooseTypeAndPages();
    if (path.startsWith('/application/integrated-enrollment')) chooseLocation();
  }

  // ---------- APPLICATION: small helpers for the site's buttons and dropdowns ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const txt = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const byText = (sel, re) => [...document.querySelectorAll(sel)].find(e => re.test(txt(e)));
  async function waitText(sel, re, ms = 10000) {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(250)) { const e = byText(sel, re); if (e) return e; }
    return null;
  }
  let toastEl = null;
  function toast(html, color = '#e6f4ea') {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;top:70px;right:16px;z-index:99999;background:#fff;border:3px solid #c8102e;border-radius:12px;padding:14px;width:300px;font:15px sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.25)';
      document.body.appendChild(toastEl);
    }
    toastEl.innerHTML = '<b style="color:#c8102e">🪪 Nepal Gov Autofill</b><div style="margin-top:8px;padding:10px;border-radius:8px;font-weight:bold;background:' + color + '">' + html + '</div>';
  }
  const clearToast = () => { if (toastEl) { toastEl.remove(); toastEl = null; } };

  // PrimeNG dropdown: open it, click the option matching re, wait for the page to load the next list
  async function pickDropdown(id, re) {
    const dd = await waitFor('#' + id);
    if (!dd) return false;
    const current = dd.querySelector('.p-dropdown-label')?.innerText.trim() || '';
    if (re.test(current)) return true;                       // already chosen
    for (let tries = 0; tries < 20; tries++) {               // options load from the server; retry until they appear
      (dd.querySelector('.p-dropdown-trigger') || dd).click();
      await sleep(600);
      const opt = [...document.querySelectorAll('.p-dropdown-panel li[role=option], .p-dropdown-items li')].find(li => re.test(li.innerText.trim()));
      if (opt) { opt.click(); await sleep(800); return true; }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(500);
    }
    return false;
  }

  // Data privacy consent popup: agree automatically and show a one-line note so the user knows
  const visible = e => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
  const consentDialog = () => [...document.querySelectorAll('.p-dialog,[role=dialog]')]
    .find(d => visible(d) && /privacy consent|गोपनीयता/i.test(txt(d)));
  async function waitForConsent(page) {
    for (let i = 0; i < 10; i++) {                        // the popup appears a moment after the page / Next
      const d = consentDialog();
      if (d) {
        const agree = [...d.querySelectorAll('button')].find(b => /i agree|सहमत/i.test(txt(b)));
        if (agree) { agree.click(); toast('✔ Data privacy consent accepted / गोपनीयता स्वीकृति दिइयो'); await sleep(800); }
        return page() || true;
      }
      await sleep(300);
    }
    return true;
  }

  // Page 1: application type -> First issuance, then Ordinary 34 pages, then Next
  let typeDone = false;
  async function chooseTypeAndPages() {
    if (typeDone) return;
    const page = () => location.pathname.toLowerCase().startsWith('/application/pre-enrollment-home');
    if (!await waitForConsent(page)) return;
    if (!/current application type/i.test(txt(document.body))) {
      // the type choices are clickable cards (div role=button), not real <button>s
      const label = await waitText('.usecase-text', CONFIG.appType);
      if (!label || !page()) return;
      (label.closest('[role=button],button,a,[tabindex]') || label).click();
    }
    const radio = await waitFor('input[name="ordinaryType"]');
    if (!radio || !page()) return;
    const row = [...document.querySelectorAll('input[name="ordinaryType"]')]
      .find(r => CONFIG.passportType.test(txt(r.closest('label') || r.parentElement.parentElement)));
    if (!row) return;
    const box = row.closest('.p-radiobutton')?.querySelector('.p-radiobutton-box') || row;
    if (!row.checked) box.click();
    await sleep(500);
    typeDone = true;
    toast('✔ First issuance (New) · Ordinary 34 pages<br>Opening the application… / आवेदन खोल्दै…');
    say('नयाँ राहदानी, चौंतीस पाना छानियो।');
    const next = await waitText('button', /^next$/i);
    if (next && page()) next.click();
    await waitForConsent(page);                           // the consent popup opens after Next
  }

  // Page 2: appointment location -> Bagmati / Kathmandu / Department of Passports, then the user picks a time
  let locDone = false;
  async function chooseLocation() {
    if (locDone) return;
    if (!await waitFor('#amsProvince', 6000)) return;      // not on the location step (e.g. a draft resumed later): stay quiet
    const ok = await pickDropdown('amsProvince', CONFIG.province)
      && await pickDropdown('amsDistrict', CONFIG.district)
      && await pickDropdown('amsProvider', CONFIG.office);
    if (!location.pathname.toLowerCase().startsWith('/application/integrated-enrollment')) return;
    locDone = true;
    if (!ok) { toast('⚠ Could not set the location. Please choose Province, District and Location yourself. / स्थान आफैं छान्नुहोस्', '#ffe5e5'); return; }
    // move on to the Time step by itself (only navigation — no booking happens here)
    for (let i = 0; i < 20; i++) {
      const next = byText('button', /^next/i);
      if (next && !next.disabled && !next.classList.contains('p-disabled')) { next.click(); break; }
      await sleep(300);
    }
    toast('✔ Kathmandu · Department of Passports<br>👉 Choose a date and time for your appointment / अपोइन्टमेन्टको मिति र समय छान्नुहोस्');
    say('काठमाडौं, राहदानी विभाग छानियो। अब अपोइन्टमेन्टको मिति र समय छान्नुहोस्।');
  }

  // ---------- DEMOGRAPHIC STEP: phone + email from the signed-in account ----------
  // The account's own details are on /account/edit; load that page invisibly and read them.
  let accountInfo = null;
  async function getAccountInfo() {
    if (accountInfo) return accountInfo;
    const f = document.createElement('iframe');
    f.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;left:-9999px;border:0';
    f.src = '/account/edit';
    document.body.appendChild(f);
    try {
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        const d = f.contentDocument;
        const ph = d && d.querySelector('#phone'), em = d && d.querySelector('#email');
        if (ph && em && em.value && ph.value.replace(/\D/g, '').length > 6) {
          accountInfo = { phone: ph.value.trim(), email: em.value.trim() };
          break;
        }
      }
    } catch (e) { /* ignore */ }
    f.remove();
    return accountInfo;
  }
  const isEmptyPhone = v => v.replace(/\D/g, '').replace(/^977/, '').length === 0;
  // Fill each new phone/email box once (the page re-draws them, e.g. on the Appointment summary)
  let contactBusy = false;
  const filledBoxes = new WeakSet();
  async function fillContact() {
    if (contactBusy) return;
    const ph = document.querySelector('#phoneNumber'), em = document.querySelector('#email');
    if (!ph || !em || !visible(ph) || filledBoxes.has(ph)) return;
    if (!isEmptyPhone(ph.value) && em.value.trim()) { filledBoxes.add(ph); return; }   // already filled
    contactBusy = true;
    const acc = await getAccountInfo();
    contactBusy = false;
    if (!acc || !ph.isConnected) return;
    if (isEmptyPhone(ph.value)) setVal('#phoneNumber', acc.phone);
    if (!em.value.trim()) setVal('#email', acc.email);
    filledBoxes.add(ph);
    toast('✔ Phone and email filled from your account / फोन र इमेल भरियो<br>👉 Type the captcha / क्याप्चा लेख्नुहोस्');
    const cap = document.querySelector('#captcha');
    if (cap && visible(cap)) cap.focus();
  }
  setInterval(() => { if (location.pathname.toLowerCase().startsWith('/application/integrated-enrollment')) fillContact(); }, 1000);

  // ---------- TIME STEP: when the user taps a time slot, go Next by itself ----------
  // Next here only opens the Appointment summary; the booking itself is confirmed on the summary page.
  document.addEventListener('click', e => {
    if (!e.isTrusted || !location.pathname.toLowerCase().startsWith('/application/integrated-enrollment')) return;
    if (!e.target.closest || !e.target.closest('.time-item')) return;
    setTimeout(async () => {
      if (!document.querySelector('.time-item.active')) return;           // slot really selected
      for (let i = 0; i < 10; i++) {
        const next = byText('button', /^next/i);
        if (next && !next.disabled && !next.classList.contains('p-disabled')) {
          toast('✔ Time chosen — opening the appointment summary / समय छानियो');
          next.click(); return;
        }
        await sleep(300);
      }
    }, 700);
  }, true);

  // ---------- DEMOGRAPHIC STEP: scan the citizenship certificate ----------
  // Fills: Citizenship number, Place of birth, Place of issue (district), Date of issue (BS).
  const norm = t => (t || '').toLowerCase().replace(/[^a-z]/g, '');
  const labelOf = el => { let p = el.parentElement, t = ''; for (let i = 0; i < 5 && p && !t; i++, p = p.parentElement) { const l = p.querySelector('label'); t = l ? txt(l) : ''; } return t; };
  // type into a box like a person would (works with the site's masked date boxes too)
  function typeInto(el, value) {
    el.focus(); el.select && el.select();
    if (!document.execCommand('insertText', false, value)) setVal('#' + el.id, value);
    el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('blur', { bubbles: true }));
  }
  // choose a district in a dropdown even if the spelling differs a little (Kavre / Kavrepalanchok)
  async function pickDistrict(dd, name) {
    if (!dd || !name) return false;
    const want = norm(name);
    const cur = dd.querySelector('.p-dropdown-label:not(.p-placeholder)'); if (cur && txt(cur)) return true;   // already chosen
    for (let tries = 0; tries < 10; tries++) {
      (dd.querySelector('.p-dropdown-trigger') || dd).click();
      await sleep(600);
      const opts = [...document.querySelectorAll('.p-dropdown-panel li[role=option], .p-dropdown-items li')];
      if (opts.length > 1) {
        const n = li => norm(txt(li).split('/')[0]);
        const hit = opts.find(li => n(li) === want)
          || opts.find(li => n(li).startsWith(want.slice(0, 5)) || want.startsWith(n(li).slice(0, 5)));
        if (hit) { hit.click(); await sleep(600); return true; }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return false;
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(500);
    }
    return false;
  }

  const citShown = new WeakSet();
  function offerCitizenshipScan() {
    const cit = document.querySelector('#minorID');
    if (!cit || !visible(cit) || citShown.has(cit) || cit.value.trim()) return;
    citShown.add(cit);
    toast(`👉 Scan the citizenship certificate (front, and back if needed)<br>नागरिकताको प्रमाणपत्रको फोटो खिच्नुहोस्
      <label style="display:block;margin-top:10px;padding:12px;background:#c8102e;color:#fff;text-align:center;border-radius:8px;cursor:pointer">
      📷 Scan citizenship / नागरिकता स्क्यान<input id="k-cit" type="file" accept="image/*" multiple hidden></label>
      <div id="k-cit-msg" style="margin-top:6px;font-weight:normal;font-size:13px"></div>`, '#fff4e5');
    say('अब नागरिकताको प्रमाणपत्रको फोटो खिच्नुहोस्।');
    const input = toastEl.querySelector('#k-cit'), note = t => { const m = toastEl && toastEl.querySelector('#k-cit-msg'); if (m) m.innerHTML = t; };
    input.onchange = async () => {
      const files = [...input.files].slice(0, 2);
      if (!files.length) return;
      note('⏳ Reading certificate… / पढ्दै…');
      try {
        const images = [];
        for (const f of files) images.push(await toJpegBase64(f));
        savePhotos('citizenship', images);     // kept briefly for the Supporting documents step
        const d = await post(CONFIG.scanServer, { kind: 'citizenship', images });
        const done = [], missing = [];
        const box = document.querySelector('#minorID');
        if (d.citizenshipNo && box && !box.value.trim()) { typeInto(box, d.citizenshipNo); done.push('Citizenship no.'); } else if (!d.citizenshipNo) missing.push('Citizenship no.');
        const birthDD = [...document.querySelectorAll('.p-dropdown')].find(x => /place of birth/i.test(labelOf(x)));
        if (await pickDistrict(birthDD, d.birthDistrict)) done.push('Place of birth'); else missing.push('Place of birth');
        if (await pickDistrict(document.querySelector('#minorIDPlaceOfIssue'), d.issueDistrict)) done.push('Place of issue'); else missing.push('Place of issue');
        const date = document.querySelector('#minorIDDateOfIssue');
        if (d.issueDateBS && date && !date.value.replace(/[_\-\s]/g, '')) { typeInto(date, d.issueDateBS); done.push('Date of issue'); } else if (!d.issueDateBS) missing.push('Date of issue');
        note((done.length ? '✔ Filled: ' + done.join(', ') : '') + (missing.length ? '<br>⚠ Please fill yourself: ' + missing.join(', ') : '') + '<br>👉 Check them against the certificate / प्रमाणपत्रसँग मिलाउनुहोस्');
        say(missing.length ? 'केही विवरण भरियो। बाँकी आफैं भर्नुहोस्।' : 'नागरिकताको विवरण भरियो। प्रमाणपत्रसँग मिलाएर जाँच्नुहोस्।');
      } catch (err) { note('❌ ' + err.message); }
      input.value = '';
    };
  }
  setInterval(() => { if (location.pathname.toLowerCase().startsWith('/application/integrated-enrollment')) offerCitizenshipScan(); }, 1000);

  // ---------- SUPPORTING DOCUMENTS: upload the NID + citizenship photos by themselves ----------
  // Photos from the earlier scans are kept on this device only, for 3 hours at most,
  // and deleted as soon as they are uploaded.
  const PHOTO_MS = 3 * 60 * 60 * 1000;
  function savePhotos(kind, imgs) { try { GM_setValue('photos_' + kind, { imgs, t: Date.now() }); } catch (e) { /* too big for storage: skip */ } }
  function loadPhotos(kind) {
    const p = GM_getValue('photos_' + kind, null);
    if (p && Date.now() - p.t < PHOTO_MS && p.imgs && p.imgs.length) return p.imgs;
    if (p) GM_deleteValue('photos_' + kind);
    return null;
  }
  // make a base64 JPEG fit under the site's 1 MB limit
  async function b64ToFile(b64, name) {
    let blob = await (await fetch('data:image/jpeg;base64,' + b64)).blob();
    if (blob.size > 950 * 1024) {
      const img = new Image(); img.src = URL.createObjectURL(blob); await img.decode();
      const c = document.createElement('canvas');
      for (const [px, q] of [[1600, 0.8], [1400, 0.7], [1200, 0.6], [1000, 0.55]]) {
        const k = Math.min(1, px / Math.max(img.naturalWidth, img.naturalHeight));
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
        if (blob.size <= 950 * 1024) break;
      }
      URL.revokeObjectURL(img.src);
    }
    return new File([blob], name, { type: 'image/jpeg' });
  }
  const scanStatus = () => { const m = txt(document.body).match(/Selected scan target: ([^.]+)\. Scans uploaded: (\d+)\/(\d+)/); return m ? { target: m[1], done: +m[2], max: +m[3] } : null; };
  async function selectTarget(re) {
    const li = [...document.querySelectorAll('li.p-listbox-item')].find(l => re.test(txt(l)));
    if (!li) return false;
    li.click();
    for (let i = 0; i < 20; i++) { await sleep(250); const st = scanStatus(); if (st && re.test(st.target)) return true; }
    return false;
  }
  // put the photos into the upload box for one document type; returns how many were attached
  async function uploadPhotos(re, imgs, label) {
    if (!imgs || !imgs.length || !await selectTarget(re)) return 0;
    let n = 0;
    for (let i = 0; i < imgs.length; i++) {
      const st = scanStatus();
      if (!st || st.done >= st.max) break;
      const input = document.querySelector('input[type=file]');
      if (!input) break;
      const dt = new DataTransfer(); dt.items.add(await b64ToFile(imgs[i], label + '-' + (i + 1) + '.jpg'));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let w = 0; w < 60; w++) { await sleep(250); const s2 = scanStatus(); if (s2 && s2.done > st.done) { n++; break; } }
    }
    return n;
  }
  async function pickToB64(input) { const out = []; for (const f of [...input.files].slice(0, 2)) out.push(await toJpegBase64(f)); input.value = ''; return out; }

  const docsSeen = new WeakSet();
  let docsBusy = false;
  async function onDocsStep() {
    const input = document.querySelector('input[type=file]');
    if (docsBusy || !input || docsSeen.has(input) || !scanStatus()) return;
    docsSeen.add(input); docsBusy = true;
    const line = (ok, t) => (ok ? '✔ ' : '👉 ') + t;
    const render = (cit, nid) => {
      const cs = (scanStatus() && /citizenship/i.test(scanStatus().target)) ? ' (' + scanStatus().done + '/' + scanStatus().max + ')' : '';
      toast(`${line(cit, 'Citizenship certificate (both sides)' + (cit ? ' uploaded' : cs))}<br>${line(nid, 'National eID' + (nid ? ' uploaded' : ''))}
        ${cit ? '' : '<label style="display:block;margin-top:8px;padding:10px;background:#c8102e;color:#fff;text-align:center;border-radius:8px;cursor:pointer">📷 Add citizenship (front + back)<input id="k-up-cit" type="file" accept="image/*" multiple hidden></label>'}
        ${nid ? '' : '<label style="display:block;margin-top:8px;padding:10px;background:#c8102e;color:#fff;text-align:center;border-radius:8px;cursor:pointer">📷 Add National eID photo<input id="k-up-nid" type="file" accept="image/*" hidden></label>'}
        <div id="k-up-msg" style="margin-top:6px;font-weight:normal;font-size:13px"></div>`, cit && nid ? '#e6f4ea' : '#fff4e5');
      const note = t => { const m = toastEl && toastEl.querySelector('#k-up-msg'); if (m) m.textContent = t; };
      const ci = toastEl.querySelector('#k-up-cit'), ni = toastEl.querySelector('#k-up-nid');
      if (ci) ci.onchange = async () => { note('⏳ Uploading…'); const ok = await uploadPhotos(/citizenship/i, await pickToB64(ci), 'citizenship') > 0; await check(); render(state.cit, state.nid); if (!ok) note('⚠ Could not upload — use the site\'s Add button'); else if (!state.cit) note('👉 Add the other side too / अर्को पाटो पनि थप्नुहोस्'); };
      if (ni) ni.onchange = async () => { note('⏳ Uploading…'); const ok = await uploadPhotos(/national eid/i, await pickToB64(ni), 'nid') > 0; await check(); render(state.cit, state.nid); if (!ok) note('⚠ Could not upload — use the site\'s Add button'); };
    };
    const state = { cit: false, nid: false };
    // citizenship is complete when every required side is in (2/2); NID when at least one photo is in
    const check = async () => {
      if (await selectTarget(/national eid/i)) state.nid = (scanStatus() || {}).done > 0;
      if (await selectTarget(/citizenship/i)) { const st = scanStatus() || {}; state.cit = st.done >= st.max; }
    };
    toast('⏳ Adding your documents… / कागजात थप्दै…');
    await check();                                         // already uploaded earlier?
    if (!state.cit) { const imgs = loadPhotos('citizenship'); if (imgs && await uploadPhotos(/citizenship/i, imgs, 'citizenship')) GM_deleteValue('photos_citizenship'); }
    if (!state.nid) { const imgs = loadPhotos('nid'); if (imgs && await uploadPhotos(/national eid/i, imgs, 'nid')) GM_deleteValue('photos_nid'); }
    await check();
    render(state.cit, state.nid);
    say(state.cit && state.nid ? 'कागजातहरू अपलोड भए। जाँचेर Next थिच्नुहोस्।' : 'बाँकी कागजातको फोटो थप्नुहोस्।');
    docsBusy = false;
  }
  setInterval(() => { if (location.pathname.toLowerCase().startsWith('/application/integrated-enrollment')) onDocsStep(); }, 1000);

  // ---------- AUTO NEXT: move on when every required box on a step is filled ----------
  // Never on a page with a captcha (appointment booking, final Apply) and never presses Apply.
  let lastTyping = 0;
  document.addEventListener('input', e => { if (e.isTrusted) lastTyping = Date.now(); }, true);
  document.addEventListener('keydown', e => { if (e.isTrusted) lastTyping = Date.now(); }, true);
  const stepKey = () => txt(document.querySelector('.p-steps-current') || document.body).slice(0, 30) + '|' +
    [...document.querySelectorAll('.p-breadcrumb .p-menuitem-link, .p-menuitem-link-active')].map(txt).join('>') + '|' +
    [...document.querySelectorAll('h1,h2,h3,h4,h5,legend')].filter(visible).map(txt).join('|');
  function requiredFilled() {
    const labels = [...document.querySelectorAll('label')].filter(l => visible(l) && /\*\s*$/.test(txt(l)));
    if (!labels.length) return false;
    for (const l of labels) {
      let box = null;
      for (let p = l.parentElement, i = 0; p && i < 4 && !box; p = p.parentElement, i++) box = p.querySelector('.p-dropdown, input:not([type=hidden]), textarea');
      if (!box) return false;
      if (box.classList.contains('p-dropdown')) { const v = box.querySelector('.p-dropdown-label:not(.p-placeholder)'); if (!v || !txt(v)) return false; }
      else if (box.type === 'radio' || box.type === 'checkbox') { const name = box.name; if (name && ![...document.querySelectorAll('input[name="' + name + '"]')].some(r => r.checked)) return false; }
      else if (!box.value.replace(/[_\s]/g, '').replace(/^\+977$/, '')) return false;
    }
    return true;
  }
  const stepsAdvanced = new Set();
  setInterval(() => {
    if (!location.pathname.toLowerCase().startsWith('/application/integrated-enrollment')) return;
    if (document.querySelector('#captcha') && visible(document.querySelector('#captcha'))) return;   // booking / final page: user decides
    if (document.querySelector('.p-dialog') && visible(document.querySelector('.p-dialog'))) return;
    if (Date.now() - lastTyping < 2000 || docsBusy || contactBusy) return;
    const key = stepKey();
    if (stepsAdvanced.has(key)) return;
    const next = byText('button', /^next$/i);
    if (!next || next.disabled || next.classList.contains('p-disabled')) return;
    if ([...document.querySelectorAll('.ng-invalid.ng-dirty, .ng-invalid.ng-touched, .p-invalid')].some(visible)) return;
    // Proxy details are only for minors: skip when nobody typed a proxy
    if (/only for minors/i.test(txt(document.body)) && ![...document.querySelectorAll('input:not([type=hidden])')].some(i => visible(i) && i.value.trim())) { stepsAdvanced.add(key); next.click(); return; }
    const docs = scanStatus();
    if (docs) { if (!document.querySelector('.option-icon.icon-red') ) { stepsAdvanced.add(key); next.click(); } return; }   // documents: all required scans in
    if (!requiredFilled()) return;
    stepsAdvanced.add(key);
    next.click();
  }, 1000);

  // ---------- AFTER SIGN-IN: go straight to "Apply for a document" ----------
  // Only right after the login page (within 2 minutes), so normal visits to Home are left alone.
  async function openApplyAfterLogin() {
    const seen = GM_getValue('loginSeenAt', 0);
    if (!seen || Date.now() - seen > 2 * 60 * 1000) return;
    const link = await waitFor('a[href="/application/pre-enrollment-home"]', 8000);   // only shown when signed in
    if (!link || !['/', '/home'].includes(location.pathname.toLowerCase())) return;
    GM_deleteValue('loginSeenAt');
    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;top:70px;right:16px;z-index:99999;background:#e6f4ea;border:3px solid #1a7f37;border-radius:12px;padding:14px;font:16px sans-serif;font-weight:bold';
    toast.textContent = '✔ Signed in — opening Apply for a document… / आवेदन खोल्दै…';
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
    say('साइन इन भयो। आवेदन फारम खोल्दै।');
    link.click();
  }
  pendingLogin();                             // drop anything older than 30 minutes
  route();
  setInterval(route, 500);
})();
