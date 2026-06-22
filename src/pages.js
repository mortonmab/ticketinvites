'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const SHELL = (title, body) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{ --gold:#b8860b; --gold-2:#d4af37; --ink:#2a2620; --muted:#6b6457; --line:#e7ddc7; }
  *{ box-sizing:border-box; }
  body{ margin:0; font-family:Georgia,'Times New Roman',serif; color:var(--ink);
    background:radial-gradient(120% 80% at 50% -10%, #fbf6ea 0%, #f3ecdb 55%, #efe6d0 100%);
    min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
  .card{ width:100%; max-width:440px; background:#fff; border:1px solid var(--line);
    border-radius:18px; padding:34px 30px; box-shadow:0 18px 50px rgba(120,90,20,.14);
    position:relative; overflow:hidden; }
  .card:before{ content:""; position:absolute; inset:0 0 auto 0; height:5px;
    background:linear-gradient(90deg,var(--gold),var(--gold-2),var(--gold)); }
  .crown{ text-align:center; font-size:26px; color:var(--gold); letter-spacing:2px; }
  .kicker{ text-align:center; text-transform:uppercase; letter-spacing:3px; font-size:11px;
    color:var(--muted); margin:6px 0 2px; }
  h1{ text-align:center; font-size:25px; margin:4px 0 2px; }
  .sub{ text-align:center; color:var(--muted); font-size:14px; margin-bottom:18px; }
  .name{ text-align:center; font-size:22px; color:var(--gold); margin:10px 0 4px; font-weight:bold; }
  .meta{ text-align:center; font-size:12px; color:var(--muted); margin-bottom:20px; }
  label{ display:block; font-size:13px; color:var(--muted); margin:14px 0 6px; letter-spacing:.3px; }
  textarea,input[type=password]{ width:100%; border:1px solid var(--line); border-radius:10px;
    padding:11px 12px; font-family:inherit; font-size:15px; color:var(--ink); background:#fdfbf6; }
  textarea{ min-height:84px; resize:vertical; }
  .choices{ display:flex; gap:12px; }
  .choice{ flex:1; }
  .choice input{ position:absolute; opacity:0; }
  .choice label{ display:block; text-align:center; margin:0; padding:14px; border:1.5px solid var(--line);
    border-radius:12px; cursor:pointer; font-size:16px; font-family:inherit; color:var(--ink);
    transition:all .15s; }
  .choice input:checked + label{ border-color:var(--gold); background:#fbf3df; color:var(--gold); font-weight:bold; }
  button{ width:100%; margin-top:22px; padding:14px; border:0; border-radius:12px; cursor:pointer;
    background:linear-gradient(90deg,var(--gold),var(--gold-2)); color:#fff; font-size:16px;
    font-family:inherit; letter-spacing:1px; box-shadow:0 8px 20px rgba(184,134,11,.3); }
  button:active{ transform:translateY(1px); }
  .pill{ display:inline-block; padding:5px 14px; border-radius:999px; font-size:13px; font-weight:bold; }
  .pill.yes{ background:#e7f6ea; color:#1f7a3d; }
  .pill.no{ background:#fdeaea; color:#b4322a; }
  .pill.pending{ background:#f3ecdb; color:var(--muted); }
  .center{ text-align:center; }
  .foot{ text-align:center; font-size:11px; color:var(--muted); margin-top:22px; letter-spacing:.5px; }
  .divider{ height:1px; background:var(--line); margin:20px 0; }
  .ok{ color:#1f7a3d; } .err{ color:#b4322a; text-align:center; margin-top:10px; font-size:13px; }
</style></head><body><div class="card">
<div class="crown">♛</div>
<div class="kicker">Worship Moments 2026</div>
${body}
<div class="foot">7 ARTS THEATRE, AVONDALE · 27 JUNE 2026 · 6:00PM</div>
</div></body></html>`;

function rsvpForm(inv, rsvp, error) {
  const yc = rsvp && rsvp.status === 'Yes' ? 'checked' : '';
  const nc = rsvp && rsvp.status === 'No' ? 'checked' : '';
  const prior = rsvp
    ? `<div class="center" style="margin-bottom:14px"><span class="pill ${rsvp.status === 'Yes' ? 'yes' : 'no'}">You previously replied: ${esc(rsvp.status)}</span></div>`
    : '';
  return SHELL('RSVP · Worship Moments', `
  <h1>You're Invited</h1>
  <div class="sub">With Janet Manyowa</div>
  <div class="name">${esc(inv.name)}</div>
  <div class="meta">Kindly confirm your attendance below</div>
  ${prior}
  <form method="POST" action="/r/${esc(inv.id)}">
    <label>Will you be attending?</label>
    <div class="choices">
      <div class="choice"><input type="radio" id="yes" name="status" value="Yes" ${yc}><label for="yes">Yes, I'll attend</label></div>
      <div class="choice"><input type="radio" id="no" name="status" value="No" ${nc}><label for="no">No, I can't</label></div>
    </div>
    <label for="comments">Comments (optional)</label>
    <textarea id="comments" name="comments" placeholder="Anything you'd like us to know...">${esc(rsvp ? rsvp.comments : '')}</textarea>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <button type="submit">Send my RSVP</button>
  </form>`);
}

function rsvpThanks(inv, status) {
  const msg = status === 'Yes'
    ? 'Wonderful — we look forward to worshipping with you.'
    : "Thank you for letting us know. You'll be missed.";
  return SHELL('Thank you · Worship Moments', `
  <h1>Thank You</h1>
  <div class="name">${esc(inv.name)}</div>
  <div class="center" style="margin:12px 0"><span class="pill ${status === 'Yes' ? 'yes' : 'no'}">RSVP: ${esc(status)}</span></div>
  <div class="sub">${esc(msg)}</div>
  <div class="divider"></div>
  <div class="center" style="font-size:13px;color:#6b6457">You can change your response anytime using the same link.</div>
  <a href="/r/${esc(inv.id)}" style="text-decoration:none"><button>Update my response</button></a>`);
}

function verifyPage(inv, rsvp, authRequired) {
  const status = rsvp ? rsvp.status : 'Pending';
  const pillClass = status === 'Yes' ? 'yes' : status === 'No' ? 'no' : 'pending';
  const checkedBadge = inv.checkedIn
    ? `<div class="center" style="margin-top:6px"><span class="pill yes">✓ Checked in${inv.checkedInAt ? ' · ' + esc(new Date(inv.checkedInAt).toLocaleString()) : ''}</span></div>`
    : '';
  return SHELL('Entrance Verification', `
  <div class="kicker" style="margin-top:8px">Entrance Verification</div>
  <div class="name">${esc(inv.name)}</div>
  <div class="meta">ID: ${esc(inv.id)}</div>
  <div class="center"><span class="pill ${pillClass}">RSVP: ${esc(status)}</span></div>
  ${checkedBadge}
  <div class="divider"></div>
  <div id="action">
    ${inv.checkedIn
      ? '<div class="center ok" style="font-weight:bold">Already admitted</div>'
      : `${authRequired ? '<label for="pin">Gate PIN</label><input type="password" id="pin" placeholder="Enter staff PIN">' : ''}
         <button onclick="checkin()">Check in this guest</button>
         <div id="msg" class="err"></div>`}
  </div>
  <script>
    async function checkin(){
      var pinEl=document.getElementById('pin');
      var body=${authRequired ? '{ pin: (pinEl?pinEl.value:"") }' : '{}'};
      var r=await fetch('/v/${esc(inv.id)}/checkin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      var d=await r.json();
      if(r.ok){ document.getElementById('action').innerHTML='<div class="center ok" style="font-weight:bold">✓ Checked in successfully</div>'; }
      else { document.getElementById('msg').textContent=d.error||'Failed'; }
    }
  </script>`);
}

function notFound() {
  return SHELL('Not found', `
  <h1>Invitation Not Found</h1>
  <div class="sub">This link is invalid or the invitation list has been regenerated. Please contact the event organiser.</div>`);
}

module.exports = { rsvpForm, rsvpThanks, verifyPage, notFound };
