'use strict';
 
// Now talking directly to your FastAPI backend
const USE_MOCK = false;
const API_BASE = 'http://127.0.0.1:8000';
 
// Map centre. 
const CAMPUS_CENTER = [28.7195, 77.0640];
 
const LOCATIONS = [
  { name: 'Academic Block A', dLat:  0.0007, dLng: -0.0009, weight: 3 },
  { name: 'Academic Block B', dLat:  0.0007, dLng:  0.0009, weight: 3 },
  { name: 'Computer Center',  dLat: -0.0002, dLng: -0.0004, weight: 3 },
  { name: 'Library',          dLat: -0.0004, dLng:  0.0008, weight: 2 },
  { name: 'Workshop and Labs',dLat: -0.0010, dLng: -0.0010, weight: 3 },
  { name: 'Canteen',          dLat: -0.0012, dLng:  0.0006, weight: 1 },
  { name: 'Hostel',           dLat:  0.0016, dLng:  0.0000, weight: 2 },
  { name: 'Parking and Gates',dLat: -0.0018, dLng:  0.0000, weight: 1 },
];
 
const STATUSES = ['Reported', 'Assigned', 'In progress', 'Resolved'];
 
/* ---------- small helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const slug = (s) => s.toLowerCase().replace(/\s+/g, '-');
 
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// FIX: Handle Supabase's automatic lowercasing of columns
function getCreatedAt(r) {
  return r.createdAt || r.createdat || Date.now();
}
function getResolvedAt(r) {
  return r.resolvedAt || r.resolvedat || null;
}
 
function timeAgo(ms) {
  if (!ms) return '';
  const mins = Math.max(1, Math.round((Date.now() - ms) / 60000));
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return hrs + ' h ago';
  return Math.round(hrs / 24) + ' days ago';
}
 
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}
 
/* ---------- 2. DEMO DATA (Fallback) ---------- */
let reports = [];
let nextId = 112;
 
async function loadReports() {
  if (!USE_MOCK) {
    try {
      const res = await fetch(`${API_BASE}/api/reports`);
      if (!res.ok) throw new Error('Bad response');
      reports = await res.json();
      return;
    } catch (err) {
      toast('Could not reach the server. Make sure main.py is running.');
    }
  }
}
 
/* ---------- 3. PRIORITY SCORE ---------- */
function priority(r) {
  const loc = LOCATIONS.find((l) => l.name === r.location)?.weight ?? 1;
  const created = getCreatedAt(r);
  const hrs = Math.min((Date.now() - created) / 3600000, 48);
  const dupes = Math.min((r.reports - 1) * 2, 10);
  return Math.round(r.severity * 3 + (r.safety ? 5 : 0) + dupes + loc + hrs / 8);
}

function level(p) {
  if (p >= 24) return 'critical';
  if (p >= 16) return 'high';
  if (p >= 10) return 'medium';
  return 'low';
}

const SLA_HOURS = { critical: 12, high: 24, medium: 48, low: 72 };
 
function isOverdue(r) {
  if (r.status === 'Resolved') return false;
  const created = getCreatedAt(r);
  const hrs = (Date.now() - created) / 3600000;
  return hrs > SLA_HOURS[level(priority(r))];
}
 
function badge(p, lv) {
  return `<span class="badge badge-${lv}">${lv.charAt(0).toUpperCase() + lv.slice(1)} <b>${p}</b></span>`;
}
 
/* ---------- 4a. NAVIGATION ---------- */
function showView(name) {
  if (name === 'dashboard') {
    const pwd = prompt("Enter staff password:");
    if (pwd !== "admin123") { // Change this to your preferred password
      toast("Incorrect password");
      return;
    }
  }
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.id === 'view-' + name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === name));
  if (name === 'issues') { initMap(); renderIssues(); setTimeout(() => map && map.invalidateSize(), 50); }
  if (name === 'dashboard') renderDashboard();
  window.scrollTo({ top: 0 });
}
// Listen for tab clicks
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => showView(t.dataset.view));
});

// Listen for CampusFix logo clicks (routes to home)
document.querySelector('.brand').addEventListener('click', (e) => {
  e.preventDefault();
  showView('report');
});
/* ---------- 4b. REPORT FORM ---------- */
let photoData = null;
 
function setupForm() {
  $('#location').innerHTML = '<option value="">Choose a place</option>' +
    LOCATIONS.map((l) => `<option>${esc(l.name)}</option>`).join('');
 
  // FIX: Image compression to prevent huge payload crashes
  $('#photo').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const img = new Image();
    const reader = new FileReader();

    reader.onload = () => {
      img.src = reader.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 800; // Compress size
        const scale = Math.min(1, MAX_WIDTH / img.width);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        photoData = canvas.toDataURL('image/jpeg', 0.7);
        $('#photo-preview').src = photoData;
        $('#photo-preview').hidden = false;
        $('#drop-empty').hidden = true;
      };
    };
    reader.readAsDataURL(file);
  });
 
  setupVoice();
  $('#report-form').addEventListener('submit', onSubmit);
}
 
function setupVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $('#voice-wrap').hidden = true; return; }
  let rec = null;
  const btn = $('#voice-btn');
 
  btn.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = $('#voice-lang').value;
    rec.interimResults = false;
    rec.onresult = (e) => {
      const said = e.results[0][0].transcript;
      const box = $('#description');
      box.value = (box.value ? box.value + ' ' : '') + said;
    };
    rec.onerror = () => toast('Could not hear that. Try again.');
    rec.onend = () => { rec = null; btn.textContent = 'Speak'; btn.classList.remove('is-listening'); };
    rec.start();
    btn.textContent = 'Listening...';
    btn.classList.add('is-listening');
  });
}
 
async function onSubmit(e) {
  e.preventDefault();
  const description = $('#description').value.trim();
  const location = $('#location').value;
  const room = $('#room').value.trim();
  const err = $('#form-error');
 
  if (description.length < 5) { err.textContent = 'Describe the problem in a few words.'; return; }
  if (!location) { err.textContent = 'Choose where the problem is.'; return; }
  err.textContent = '';
 
  $('#report-form').hidden = true;
  const box = $('#result');
  box.hidden = false;
  box.innerHTML = '<div class="thinking"><div class="spinner"></div><span>AI is sorting your report...</span></div>';
 
  const outcome = await createReport({ description, location, room, photo: photoData });
  showResult(outcome);
}
 
async function createReport({ description, location, room, photo }) {
  if (!USE_MOCK) {
    try {
      const res = await fetch(`${API_BASE}/api/reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, location, room, photo }),
      });
      if (!res.ok) throw new Error('Bad response');
      const data = await res.json();
      await loadReports();
      return data;
    } catch (err) {
      toast('Server not reachable. Ensure main.py is running.');
      return { merged: false, report: { id: "ERROR", summary: "Server Error", category: "Error", dept: "None", severity: 1, safety: false }};
    }
  }
}
 
function showResult({ merged, report: r }) {
  const p = priority(r), lv = level(p);
  $('#result').innerHTML = `
    <h2>${merged ? 'Added to an existing report' : 'Report sent: ' + esc(r.id)}</h2>
    <p class="muted">${esc(r.summary)}</p>
    ${merged ? `<div class="result-note">This matches an open issue at ${esc(r.location)}. Instead of a duplicate ticket, your report was added. ${r.reports} students have now reported it, which raises its priority.</div>` : ''}
    <dl class="facts">
      <div><dt>Category</dt><dd>${esc(r.category)}</dd></div>
      <div><dt>Sent to</dt><dd>${esc(r.dept)}</dd></div>
      <div><dt>Severity</dt><dd>${r.severity} of 5</dd></div>
      <div><dt>Safety risk</dt><dd>${r.safety ? 'Yes, flagged urgent' : 'No'}</dd></div>
      <div><dt>Priority</dt><dd>${badge(p, lv)}</dd></div>
    </dl>
    <div class="result-actions">
      <button class="btn-secondary" id="track-btn">Track this issue</button>
      <button class="btn-ghost" id="again-btn">Report another issue</button>
    </div>`;
 
  $('#track-btn').addEventListener('click', () => { showView('issues'); focusIssue(r.id); });
  $('#again-btn').addEventListener('click', resetForm);
}
 
function resetForm() {
  $('#report-form').reset();
  photoData = null;
  $('#photo-preview').hidden = true;
  $('#drop-empty').hidden = false;
  $('#result').hidden = true;
  $('#report-form').hidden = false;
}
 
/* ---------- 4c. LIVE ISSUES + MAP ---------- */
let map = null;
let markerLayer = null;
const markers = {};
 
function initMap() {
  if (map || typeof L === 'undefined') return;
  map = L.map('map').setView(CAMPUS_CENTER, 17);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
}
 
function position(r) {
  const loc = LOCATIONS.find((l) => l.name === r.location) || { dLat: 0, dLng: 0 };
  const n = parseInt(String(r.id).replace(/\D/g, ''), 10) || 0;
  const jitter = ((n % 7) - 3) * 0.00007;
  return [CAMPUS_CENTER[0] + loc.dLat + jitter, CAMPUS_CENTER[1] + loc.dLng - jitter];
}
 
function visibleReports() {
  const s = $('#filter-status').value;
  const c = $('#filter-category').value;
  return (reports || [])
    .filter((r) => (s === 'all' ? true : s === 'open' ? r.status !== 'Resolved' : r.status === s))
    .filter((r) => c === 'all' || r.category === c)
    .sort((a, b) => priority(b) - priority(a));
}
 
function ticketCard(r) {
  const p = priority(r), lv = level(p);
  const created = getCreatedAt(r);
  return `
  <article class="ticket ${lv === 'critical' && r.status !== 'Resolved' ? 'is-critical' : ''}" data-id="${esc(r.id)}" tabindex="0">
    <div class="ticket-top"><span class="ticket-id">${esc(r.id)}</span>${badge(p, lv)}</div>
    ${r.photo ? `<div class="ticket-photo"><img src="${r.photo}" alt="Report photo" style="width:100%; border-radius:6px; margin:8px 0; max-height:160px; object-fit:cover;" /></div>` : ''}
    <h3>${esc(r.summary)}</h3>
    <div class="ticket-meta">
      <span>${esc(r.location)}${r.room ? ', ' + esc(r.room) : ''}</span>
      <span class="chip">${esc(r.category)}</span>
    </div>
    <div class="ticket-foot" style="justify-content: space-between; width: 100%;">
      <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
        <span class="chip status-${slug(r.status)}">${esc(r.status)}</span>
        ${r.reports > 1 ? `<span>${r.reports} reports</span>` : ''}
        <span>${timeAgo(created)}</span>
      </div>
      ${(r.status === 'Resolved' || r.status === 'Verified Closed') ? `
      <div style="display: flex; gap: 6px; margin-top: 8px; width: 100%;">
        <button class="btn-secondary small verify-btn" style="flex: 1; padding: 6px;" data-id="${esc(r.id)}">Verify (${r.verifications || 0}/3)</button>
        <button class="btn-ghost small flag-btn" style="padding: 6px; color: var(--alert); border-color: var(--alert);" data-id="${esc(r.id)}">Flag Fake</button>
      </div>` : ''}
    </div>
  </article>`;
}
 
function renderIssues() {
  const list = visibleReports();
  $('#ticket-list').innerHTML = list.length
    ? list.map(ticketCard).join('')
    : '<div class="empty">No issues match these filters.</div>';
 
  if (!markerLayer) return;
  markerLayer.clearLayers();
  Object.keys(markers).forEach((k) => delete markers[k]);
  list.forEach((r) => {
    const p = priority(r), lv = level(p);
    const icon = L.divIcon({
      className: '', iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28],
      html: `<span class="pin pin-${lv}"><i>${p}</i></span>`,
    });
    const m = L.marker(position(r), { icon })
      .bindPopup(`<strong>${esc(r.summary)}</strong><br>${esc(r.location)}<br>${esc(r.status)}`)
      .addTo(markerLayer);
    m.on('click', () => highlightTicket(r.id));
    markers[r.id] = m;
  });
}
 
function highlightTicket(id) {
  document.querySelectorAll('.ticket').forEach((t) => t.classList.toggle('is-focus', t.dataset.id === id));
  const el = document.querySelector(`.ticket[data-id="${id}"]`);
  if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
 
function focusIssue(id) {
  $('#filter-status').value = 'all';
  $('#filter-category').value = 'all';
  renderIssues();
  highlightTicket(id);
  const m = markers[id];
  if (m && map) { map.flyTo(m.getLatLng(), 18, { duration: 0.8 }); m.openPopup(); }
}
 
function setupIssues() {
  const catOptions = ["Electrical", "Plumbing and water", "IT and Wi-Fi", "Lab equipment", "Furniture", "Cleanliness", "Civil and structure", "Safety and security", "General"];
  $('#filter-category').innerHTML = '<option value="all">All categories</option>' + catOptions.map((c) => `<option>${esc(c)}</option>`).join('');
  
  $('#filter-status').addEventListener('change', renderIssues);
  $('#filter-category').addEventListener('change', renderIssues);
 
  const list = $('#ticket-list');
  list.addEventListener('click', async (e) => { 
    // Handle Verify
    if (e.target.classList.contains('verify-btn')) {
      e.stopPropagation();
      e.target.disabled = true; e.target.textContent = "...";
      try {
        await fetch(`${API_BASE}/api/reports/${e.target.dataset.id}/verify`, { method: 'POST' });
        toast('Fix verified!'); await loadReports(); renderIssues();
      } catch (err) { toast('Error verifying.'); }
      return;
    }
    // Handle Flag
    if (e.target.classList.contains('flag-btn')) {
      e.stopPropagation();
      if(!confirm("Are you sure this issue is NOT actually fixed? This will alert staff.")) return;
      e.target.disabled = true; e.target.textContent = "...";
      try {
        await fetch(`${API_BASE}/api/reports/${e.target.dataset.id}/flag`, { method: 'POST' });
        toast('Flagged! Issue reopened.'); await loadReports(); renderIssues();
      } catch (err) { toast('Error flagging.'); }
      return;
    }
    // Handle regular ticket click
    const t = e.target.closest('.ticket'); 
    if (t) focusIssue(t.dataset.id); 
  });
}
 
/* ---------- 4d. STAFF DASHBOARD ---------- */
function renderDashboard() {
  const open = reports.filter((r) => r.status !== 'Resolved');
  const critical = open.filter((r) => level(priority(r)) === 'critical');
  
  // FIX: handle lowercase resolvedat 
  const resolved = reports.filter((r) => r.status === 'Resolved' && getResolvedAt(r));
  const avg = resolved.length
    ? resolved.reduce((sum, r) => sum + (getResolvedAt(r) - getCreatedAt(r)) / 3600000, 0) / resolved.length : 0;
  
  const weekAgo = Date.now() - 7 * 24 * 3600000;
  const doneThisWeek = resolved.filter((r) => getResolvedAt(r) > weekAgo).length;
 
  $('#stats').innerHTML = `
    <div class="stat"><span class="stat-num">${open.length}</span><span class="stat-label">Open issues</span></div>
    <div class="stat ${critical.length ? 'is-alert' : ''}"><span class="stat-num">${critical.length}</span><span class="stat-label">Critical right now</span></div>
    <div class="stat"><span class="stat-num">${avg ? avg.toFixed(1) + ' h' : '-'}</span><span class="stat-label">Average time to fix</span></div>
    <div class="stat"><span class="stat-num">${doneThisWeek}</span><span class="stat-label">Fixed this week</span></div>`;
 
  const counts = {};
  open.forEach((r) => { counts[r.category] = (counts[r.category] || 0) + 1; });
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = rows.length ? rows[0][1] : 1;
  $('#bars').innerHTML = rows.length
    ? rows.map(([name, n]) => `
        <div class="bar-row"><span>${esc(name)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${(n / max) * 100}%"></div></div><b>${n}</b></div>`).join('')
    : '<p class="muted">Nothing open. Good news.</p>';
 
  const groups = {};
  reports.forEach((r) => {
    const key = r.location + '|' + r.category;
    groups[key] = groups[key] || { location: r.location, category: r.category, n: 0 };
    groups[key].n += 1;
  });
  const hot = Object.values(groups).filter((g) => g.n >= 2).sort((a, b) => b.n - a.n);
  $('#hotspots').innerHTML = hot.length
    ? hot.map((g) => `<div class="hot"><strong>${esc(g.location)}: ${esc(g.category)}</strong>
        <span>${g.n} separate tickets. Check root cause.</span></div>`).join('')
    : '<p class="muted">No repeat problems yet.</p>';
 
  const queue = open.slice().sort((a, b) => priority(b) - priority(a));
  $('#queue-body').innerHTML = queue.length ? queue.map((r) => {
    const p = priority(r), lv = level(p);
    const created = getCreatedAt(r);
    return `<tr>
      <td>${badge(p, lv)}</td>
      <td class="issue-cell"><strong>${esc(r.summary)}</strong><span class="muted small">${esc(r.id)}, ${timeAgo(created)}</span></td>
      <td>${esc(r.location)}</td>
      <td>${esc(r.dept)}</td>
      <td>${r.reports}</td>
      <td>
        <select data-id="${esc(r.id)}" aria-label="Status for ${esc(r.id)}">
          ${STATUSES.map((s) => `<option ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        ${isOverdue(r) ? '<span class="chip overdue">Overdue</span>' : ''}
      </td></tr>`;
  }).join('') : '<tr><td colspan="6" class="muted">The queue is empty.</td></tr>';
}
 
function setupDashboard() {
  $('#queue-body').addEventListener('change', async (e) => {
    const sel = e.target.closest('select');
    if (!sel) return;
    const r = reports.find((x) => x.id === sel.dataset.id);
    if (!r) return;
    r.status = sel.value;
    
    // FIX: Using correct casing for update
    const updatePayload = { status: r.status };
    if (r.status === 'Resolved') {
      updatePayload.resolvedAt = Date.now();
    }
 
    if (!USE_MOCK) {
      try {
        await fetch(`${API_BASE}/api/reports/${r.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatePayload),
        });
      } catch (err) { toast('Could not reach the server.'); }
    }
    toast(r.status === 'Resolved' ? r.id + ' marked resolved' : r.id + ' is now ' + r.status.toLowerCase());
    
    // Reload from DB to ensure local state matches remote state
    await loadReports();
    renderDashboard();
  });
}
 
/* ---------- START ---------- */
(async function start() {
  await loadReports();
  setupForm();
  setupIssues();
  setupDashboard();
})();
