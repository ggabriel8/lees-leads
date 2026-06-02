const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const LEADS_FILE = path.join(__dirname, 'leads.json');

// ── Instantly API config ──────────────────────────────────────────────────────
const INSTANTLY_API_KEY = '>>REMOVED_USE_ENV_VAR==';
const POLL_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serves index.html (the CRM)

// ── Helpers ──────────────────────────────────────────────────────────────────
function readLeads() {
  try { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); }
  catch { return []; }
}

function writeLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

function isDuplicate(leads, email) {
  if (!email) return false;
  return leads.some(l => l.email && l.email.toLowerCase() === email.toLowerCase());
}

// ── API: Get all leads ────────────────────────────────────────────────────────
app.get('/api/leads', (req, res) => {
  res.json(readLeads());
});

// ── API: Create lead manually ─────────────────────────────────────────────────
app.post('/api/leads', (req, res) => {
  const leads = readLeads();
  const { name, email, phone, property, source, status } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (isDuplicate(leads, email)) return res.status(409).json({ error: 'Duplicate email' });

  const lead = {
    id: 'lead_' + Date.now(),
    name,
    email: email || '',
    phone: phone || '',
    property: property || '',
    source: source || 'Manual',
    status: status || 'new',
    createdAt: Date.now(),
    calls: [],
    notes: [],
    followUpAt: null,
    emailSentAt: null,
  };
  leads.unshift(lead);
  writeLeads(leads);
  res.json(lead);
});

// ── API: Update lead ──────────────────────────────────────────────────────────
app.patch('/api/leads/:id', (req, res) => {
  const leads = readLeads();
  const idx = leads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  leads[idx] = { ...leads[idx], ...req.body };
  writeLeads(leads);
  res.json(leads[idx]);
});

// ── INSTANTLY WEBHOOK ─────────────────────────────────────────────────────────
// Set this URL in Instantly: http://YOUR_SERVER/webhook/instantly
// (use ngrok for local: ngrok http 3000)
app.post('/webhook/instantly', (req, res) => {
  console.log('[Instantly Webhook]', JSON.stringify(req.body, null, 2));

  const data = req.body;

  // Instantly webhook payload shapes vary — handle both flat and nested
  const email =
    data.email ||
    data.lead_email ||
    data.contact?.email ||
    data.prospect?.email || '';

  const firstName =
    data.first_name ||
    data.firstName ||
    data.contact?.first_name ||
    data.prospect?.first_name || '';

  const lastName =
    data.last_name ||
    data.lastName ||
    data.contact?.last_name ||
    data.prospect?.last_name || '';

  const name = (firstName + ' ' + lastName).trim() || email.split('@')[0] || 'Unknown';

  const phone =
    data.phone ||
    data.contact?.phone ||
    data.prospect?.phone || '';

  const property =
    data.city ||
    data.location ||
    data.property ||
    data.contact?.city || '';

  const replyText =
    data.reply_text ||
    data.message ||
    data.body ||
    data.email_body || '';

  const leads = readLeads();

  if (isDuplicate(leads, email)) {
    console.log(`[Instantly] Duplicate skipped: ${email}`);
    return res.json({ status: 'duplicate', message: 'Lead already exists' });
  }

  const lead = {
    id: 'lead_instantly_' + Date.now(),
    name,
    email,
    phone,
    property,
    source: 'Instantly',
    status: 'new',
    createdAt: Date.now(),
    calls: [],
    notes: replyText ? [{ at: Date.now(), text: replyText }] : [],
    followUpAt: null,
    emailSentAt: null,
  };

  leads.unshift(lead);
  writeLeads(leads);

  console.log(`[Instantly] ✓ Lead added: ${name} <${email}>`);
  res.json({ status: 'ok', lead });
});

// ── Instantly API poller ──────────────────────────────────────────────────────
function instantlyFetch(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.instantly.ai',
      path: `/api/v2/${endpoint}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${INSTANTLY_API_KEY}`, 'Content-Type': 'application/json' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function pollInstantly() {
  try {
    console.log('[Instantly Poll] Checking for new replies…');
    // Use the correct Unibox emails endpoint, filtering for received (replied) emails
    // ue_type=2 means received, email_type=received filters for inbound replies
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // last 7 days
    const result = await instantlyFetch(`emails?email_type=received&limit=100&sort_order=desc&min_timestamp_created=${encodeURIComponent(since)}`);
    console.log('[Instantly Poll] Raw response:', JSON.stringify(result).slice(0, 500));
    const items = result.items || [];

    if (!items.length) {
      console.log('[Instantly Poll] No new replies found.');
      return;
    }

    const leads = readLeads();
    let added = 0;

    for (const item of items) {
      // Instantly email object: lead = lead email, body.text = email body
      const email = item.lead || item.from_address_email || '';
      if (!email || isDuplicate(leads, email)) continue;

      const name = email.split('@')[0];
      const replyText = (item.body && item.body.text) || item.content_preview || '';

      const lead = {
        id: 'lead_instantly_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        name,
        email,
        phone: item.phone || '',
        property: item.city || item.location || item.custom_variables?.city || '',
        source: 'Instantly',
        status: 'new',
        createdAt: Date.now(),
        calls: [],
        notes: replyText ? [{ at: Date.now(), text: replyText }] : [],
        followUpAt: null,
        emailSentAt: null,
      };

      leads.unshift(lead);
      added++;
      console.log(`[Instantly Poll] ✓ Added: ${name} <${email}>`);
    }

    if (added > 0) writeLeads(leads);
    console.log(`[Instantly Poll] Done — ${added} new lead(s) added.`);
  } catch (err) {
    console.error('[Instantly Poll] Error:', err.message);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🏠 Lee's Leads running at http://localhost:${PORT}`);
  console.log(`   Auto-syncing with Instantly every 5 minutes via API polling.\n`);
  // Poll immediately on start, then every 5 minutes
  pollInstantly();
  setInterval(pollInstantly, POLL_INTERVAL_MS);
});
