// ==UserScript==
// @name         Nepal Gov Autofill – Passport Register
// @namespace    roughdev
// @version      4.3
// @description  Scan NID front with Gemini AI -> auto-fill name/DOB/NIN, Nepali voice prompts, auto password, printable slip. Captcha + Register stay manual.
// @match        https://online.nepalpassport.gov.np/account/register*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      generativelanguage.googleapis.com
// @updateURL    https://raw.githubusercontent.com/Moktan-26/nepal-gov-autofill/main/nepal-gov-autofill.user.js
// @downloadURL  https://raw.githubusercontent.com/Moktan-26/nepal-gov-autofill/main/nepal-gov-autofill.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------- CONFIG ----------
  const CONFIG = {
    fallbackEmail: '',          // optional fallback email if the person has none (e.g. a family member's)
    smsEndpoint: '',         // your backend URL: POST {phone, message}. Empty = no SMS, just print slip
  };

  // ---------- VOICE ----------
  function say(text) {
    return new Promise(res => {
      try {
        const u = new SpeechSynthesisUtterance(text);
        const voices = speechSynthesis.getVoices();
        u.voice = voices.find(v => v.lang.startsWith('ne')) || voices.find(v => v.lang.startsWith('hi')) || null;
        u.lang = u.voice ? u.voice.lang : 'ne-NP';
        u.rate = 0.9;
        u.onend = res; u.onerror = res;
        speechSynthesis.cancel(); speechSynthesis.speak(u);
      } catch (e) { res(); }
    });
  }

  const DEV = { '०':'0','१':'1','२':'2','३':'3','४':'4','५':'5','६':'6','७':'7','८':'8','९':'9' };
  const WORDS = { 'शून्य':'0','सुन्य':'0','एक':'1','दुई':'2','तीन':'3','तिन':'3','चार':'4','पाँच':'5','पांच':'5',
    'छ':'6','सात':'7','आठ':'8','नौ':'9','zero':'0','one':'1','two':'2','three':'3','four':'4','five':'5',
    'six':'6','seven':'7','eight':'8','nine':'9' };
  function toDigits(s) {
    s = s.replace(/[०-९]/g, d => DEV[d]);
    Object.entries(WORDS).forEach(([w, d]) => (s = s.split(w).join(d)));
    return s.replace(/\D/g, '');
  }

  function listen() {
    return new Promise(res => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return res('');
      const r = new SR();
      r.lang = 'ne-NP'; r.interimResults = false; r.maxAlternatives = 3;
      r.onresult = e => res([...e.results[0]].map(a => a.transcript).join(' '));
      r.onerror = () => res(''); r.onend = () => res('');
      r.start();
    });
  }

  // ---------- GEMINI ----------
  const API = 'https://generativelanguage.googleapis.com/v1beta';

  // key goes in a header (works for both old "AIza…" and new "AQ.…" keys, and keeps it out of URLs)
  function gm(method, url, body) {
    return new Promise((res, rej) => GM_xmlhttpRequest({
      method, url, data: body ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GM_getValue('apiKey', '') },
      onload: r => {
        let j = {}; try { j = JSON.parse(r.responseText); } catch {}
        r.status >= 200 && r.status < 300 ? res(j) : rej(new Error(j.error?.message || 'HTTP ' + r.status));
      },
      onerror: () => rej(new Error('Network error')),
    }));
  }

  // Pick a Flash model the key can use (model names change over time, so ask the API)
  async function pickModel(key) {
    const saved = GM_getValue('model', '');
    if (saved) return saved;
    const { models = [] } = await gm('GET', `${API}/models?pageSize=200`);
    const ok = models.filter(m => (m.supportedGenerationMethods || []).includes('generateContent')
      && /flash/i.test(m.name) && !/image|tts|audio|live|thinking|exp/i.test(m.name));
    // prefer Flash-Lite (fastest/cheapest), newest version first
    ok.sort((a, b) => (/lite/i.test(b.name) - /lite/i.test(a.name)) || b.name.localeCompare(a.name, undefined, { numeric: true }));
    if (!ok.length) throw new Error('No Flash model available for this key');
    const name = ok[0].name.replace(/^models\//, '');
    GM_setValue('model', name);
    return name;
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

  const PROMPT = `This is a photo of a Nepal National Identity Card (front side). The photo may be rotated or upside down.
Read the ENGLISH fields and return ONLY JSON:
{"given": "first and middle names from FULL NAME", "surname": "last word of FULL NAME", "dob": "DATE OF BIRTH in AD as YYYY-MM-DD (NOT the Nepali BS date, NOT date of issue)", "nin": "NIN digits only, no dashes", "readable": true}
If it is not a Nepal NID front, or a field cannot be read clearly, set that field to "" and "readable" to false. Do not guess.`;

  async function readCard(file) {
    const key = GM_getValue('apiKey', '');
    if (!key) throw new Error('Paste your Gemini API key in the panel first');
    msg('Preparing photo…');
    const b64 = await toJpegBase64(file);
    const model = await pickModel(key);
    msg('Reading card with AI…');
    let j;
    try {
      j = await gm('POST', `${API}/models/${model}:generateContent`, {
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      });
    } catch (e) {
      if (/not found|not supported/i.test(e.message)) GM_setValue('model', '');  // model retired -> re-pick next time
      throw e;
    }
    const txt = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
    let d = {};
    try { d = JSON.parse(txt.replace(/^```(json)?|```$/g, '').trim()); } catch {}
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

  // ---------- UI ----------
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:70px;right:16px;z-index:99999;background:#fff;border:3px solid #c8102e;border-radius:12px;padding:14px;width:300px;font:15px sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.25)';
  box.innerHTML = `
    <b style="color:#c8102e;font-size:17px">🪪 Nepal Gov Autofill</b>
    <div id="k-keybox" style="margin-top:8px;padding:8px;background:#fff4e5;border-radius:6px">
      <div style="font-size:13px">🔑 Paste Gemini API key (once):</div>
      <input id="k-key" type="password" placeholder="AIza… or AQ.…" style="width:100%;box-sizing:border-box;margin-top:4px;padding:6px;border:1px solid #ccc;border-radius:4px">
      <button id="k-keysave" style="width:100%;margin-top:4px;padding:6px;border:0;border-radius:4px;background:#333;color:#fff">Save key</button>
    </div>
    <label style="display:block;margin-top:10px;padding:14px;background:#c8102e;color:#fff;text-align:center;border-radius:8px;cursor:pointer;font-size:17px">
      📷 1. NID कार्ड स्क्यान<input id="k-img" type="file" accept="image/*" capture="environment" hidden></label>
    <div id="k-fields" style="margin-top:8px"></div>
    <button id="k-mic" style="width:100%;margin-top:8px;padding:12px;font-size:16px;border-radius:8px;border:1px solid #c8102e;background:#fff">🎤 2. फोन नम्बर बोल्नुहोस्</button>
    <button id="k-go" style="width:100%;margin-top:8px;padding:12px;font-size:16px;border-radius:8px;border:0;background:#1a7f37;color:#fff">✅ 3. फारम भर्नुहोस्</button>
    <div id="k-msg" style="margin-top:8px;font-size:14px"></div>
    <a id="k-reset" href="#" style="display:block;margin-top:6px;font-size:11px;color:#888">change API key</a>`;
  document.body.appendChild(box);

  const msg = t => (box.querySelector('#k-msg').textContent = t);
  const keyBox = box.querySelector('#k-keybox');
  keyBox.style.display = GM_getValue('apiKey', '') ? 'none' : 'block';
  box.querySelector('#k-keysave').onclick = () => {
    const k = box.querySelector('#k-key').value.trim();
    if (!/^[\w.\-]{20,}$/.test(k)) return msg('That does not look like an API key — copy it again from AI Studio.');
    GM_setValue('apiKey', k); GM_setValue('model', '');
    box.querySelector('#k-key').value = '';
    keyBox.style.display = 'none';
    msg('✔ Key saved. Now scan an NID card.');
  };
  box.querySelector('#k-reset').onclick = e => { e.preventDefault(); keyBox.style.display = 'block'; };

  const F = [['given','Given name'],['surname','Surname'],['dob','DOB AD yyyy-mm-dd'],['nin','NIN'],['phone','Mobile 98XXXXXXXX'],['email','Email']];
  const fWrap = box.querySelector('#k-fields');
  F.forEach(([k, l]) => {
    const i = document.createElement('input');
    i.id = 'k-' + k; i.placeholder = l;
    i.style.cssText = 'width:100%;box-sizing:border-box;margin-top:5px;padding:7px;border:1px solid #ccc;border-radius:5px;font-size:15px';
    if (k === 'email') i.value = CONFIG.fallbackEmail;
    fWrap.appendChild(i);
  });
  const val = k => box.querySelector('#k-' + k).value.trim();
  const put = (k, v) => (box.querySelector('#k-' + k).value = v || '');

  speechSynthesis.getVoices(); // warm up voice list
  setTimeout(() => say('नमस्ते। कृपया आफ्नो राष्ट्रिय परिचयपत्रको अगाडिको फोटो खिच्नुहोस्।'), 800);

  box.querySelector('#k-img').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    e.target.value = '';
    try {
      const d = await readCard(file);
      put('given', d.given); put('surname', d.surname); put('dob', d.dob); put('nin', d.nin);
      const missing = ['given','surname','dob','nin'].filter(k => !d[k]);
      if (missing.length) {
        msg('⚠ Could not read: ' + missing.join(', ') + '. Retake photo or type it.');
        await say('कार्ड राम्रोसँग पढ्न सकिएन। फेरि फोटो खिच्नुहोस्।');
      } else {
        msg('✔ Card read. Operator: check every field against the card.');
        await say(`तपाईंको नाम ${d.given} ${d.surname}। जन्म मिति ${d.dob.split('-').join(' ')}। यो सही हो?`);
      }
    } catch (err) { msg('❌ ' + err.message); }
  };

  box.querySelector('#k-mic').onclick = async () => {
    await say('कृपया आफ्नो मोबाइल नम्बर बोल्नुहोस्।');
    msg('🎤 Listening…');
    let d = toDigits(await listen());
    if (d.startsWith('977')) d = d.slice(3);
    if (/^9\d{9}$/.test(d)) {
      put('phone', d); msg('✔ Phone: ' + d);
      await say('तपाईंको नम्बर ' + d.split('').join(' ') + '। सही हो?');
    } else {
      msg('Heard "' + d + '" — not a valid 10-digit number. Try again or type it.');
      await say('नम्बर बुझिएन। फेरि बोल्नुहोस्।');
    }
  };

  box.querySelector('#k-go').onclick = async () => {
    const d = Object.fromEntries(F.map(([k]) => [k, val(k)]));
    const bad = [];
    if (!d.given || !d.surname) bad.push('name');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.dob)) bad.push('DOB');
    if (!/^\d{10}$/.test(d.nin.replace(/\D/g, ''))) bad.push('NIN');
    if (!/^9\d{9}$/.test(d.phone.replace(/\D/g, '').replace(/^977/, ''))) bad.push('phone');
    if (!/^\S+@\S+\.\S+$/.test(d.email)) bad.push('email');
    if (bad.length) return msg('Fix: ' + bad.join(', '));

    d.pass = genPassword();
    setVal('#entityName', d.given);
    setVal('#entitySurname', d.surname);
    setVal('[name="entityDateOfBirth"]', d.dob);
    setVal('#entityId', d.nin.replace(/\D/g, ''));
    setVal('#email', d.email.toLowerCase());
    setVal('#phone', '+977' + d.phone.replace(/\D/g, '').replace(/^977/, ''));
    setVal('[name="password"],[name="repeatPassword"]', d.pass);

    const sent = await sendSMS(d.phone, `Passport portal login. Username: ${d.email} Password: ${d.pass}`);
    printSlip(d);
    msg(`✔ Filled. Password: ${d.pass} ${sent ? '(SMS sent)' : '(printed, no SMS)'}. Type captcha → Register.`);
    const cap = document.querySelector('#captcha');
    if (cap) { cap.scrollIntoView({ block: 'center' }); cap.focus(); }
    await say('फारम भरियो। तपाईंको पासवर्ड कागजमा छापिएको छ। सुरक्षित राख्नुहोस्।');
  };
})();
