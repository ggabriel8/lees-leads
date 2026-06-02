const express = require('express');
const cors = require('cors');
const https = require('https');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY;
if (!INSTANTLY_API_KEY) console.warn('[WARN] INSTANTLY_API_KEY not set — Instantly polling/webhooks will not authenticate');
const POLL_INTERVAL_MS = 5 * 60 * 1000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::BIGINT
  )`);
  console.log('[DB] Ready');
}

async function readLeads() {
  const r = await pool.query(`SELECT data FROM leads ORDER BY COALESCE((data->>'createdAt')::bigint, 0) DESC`);
  return r.rows.map(r => r.data);
}

async function getLeadById(id) {
  const r = await pool.query('SELECT data FROM leads WHERE id=$1', [id]);
  return r.rows[0] ? r.rows[0].data : null;
}

async function upsertLead(lead) {
  await pool.query(
    'INSERT INTO leads(id, data, created_at) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET data=$2',
    [lead.id, JSON.stringify(lead), lead.createdAt]
  );
}

function isDuplicate(leads, email) {
  if (!email) return false;
  return leads.some(l => l.email && l.email.toLowerCase() === email.toLowerCase());
}

// Strip emails that contain unresolved template variables like {l.property}
function sanitizeEmail(email) {
  if (!email) return '';
  if (/[{}]/.test(email)) return '';
  return email;
}

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/leads', async (req, res) => {
  try { res.json(await readLeads()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads', async (req, res) => {
  try {
    const leads = await readLeads();
    const { name, email, phone, property, source, status } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    if (isDuplicate(leads, email)) return res.status(409).json({ error: 'Duplicate email' });
    const lead = {
      id: 'lead_' + Date.now(),
      name, email: email || '', phone: phone || '', property: property || '',
      source: source || 'Manual', status: status || 'new',
      createdAt: Date.now(), calls: [], notes: [], followUpAt: null, emailSentAt: null,
    };
    await upsertLead(lead);
    res.json(lead);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/leads/:id', async (req, res) => {
  try {
    const lead = await getLeadById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Not found' });
    const updated = { ...lead, ...req.body };
    await upsertLead(updated);
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/webhook/instantly', async (req, res) => {
  try {
    const data = req.body;
    const email = sanitizeEmail(data.email || data.lead_email || (data.contact && data.contact.email) || '');
    const firstName = data.first_name || data.firstName || (data.contact && data.contact.first_name) || '';
    const lastName = data.last_name || data.lastName || (data.contact && data.contact.last_name) || '';
    let name = (firstName + ' ' + lastName).trim();
    let phone = data.phone || (data.contact && data.contact.phone) || '';
    let property = data.property || data.property_address || data.address || data.city || data.location || '';
    const replyText = data.reply_text || data.message || data.body || '';
    const leads = await readLeads();
    if (isDuplicate(leads, email)) return res.json({ status: 'duplicate' });

    // Enrich missing fields from the Instantly lead record (name/phone/property
    // often live in the lead's custom variables rather than the webhook body)
    if (email && (!name || !property || !phone)) {
      const li = await findInstantlyLead(email);
      if (li) {
        if (!name) {
          const fn = (li.first_name || '').trim();
          const ln = (li.last_name || '').trim();
          if (fn + ln) name = (fn + ' ' + ln).trim();
        }
        if (!phone) phone = (li.phone || '').trim();
        if (!property) property = extractProperty(li);
      }
    }
    if (!name) name = (email.split('@')[0] || 'Unknown');
    const lead = {
      id: 'lead_instantly_' + Date.now(),
      name, email, phone, property, source: 'Instantly', status: 'new',
      createdAt: Date.now(), calls: [],
      notes: replyText ? [{ at: Date.now(), text: replyText }] : [],
      followUpAt: null, emailSentAt: null,
    };
    await upsertLead(lead);
    res.json({ status: 'ok', lead });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function instantlyFetch(endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.instantly.ai',
      path: '/api/v2/' + endpoint,
      headers: { 'Authorization': 'Bearer ' + INSTANTLY_API_KEY },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// POST helper — Instantly v2 lead search is a POST endpoint, not GET
function instantlyPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = https.request({
      hostname: 'api.instantly.ai',
      path: '/api/v2/' + endpoint,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + INSTANTLY_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Pull a property/address out of an Instantly lead's custom variables (payload)
const PROPERTY_KEYS = [
  'property', 'property_address', 'propertyAddress', 'address', 'property_city',
  'listing', 'listing_address', 'home', 'home_address', 'street', 'street_address',
  'city', 'location',
];
function extractProperty(li) {
  if (!li) return '';
  const p = li.payload || li.custom_variables || {};
  for (const k of PROPERTY_KEYS) {
    if (p[k] && String(p[k]).trim()) return String(p[k]).trim();
  }
  // Fall back to any payload key that looks address/property related
  for (const [k, v] of Object.entries(p)) {
    if (/address|property|listing|home|street/i.test(k) && v && String(v).trim()) {
      return String(v).trim();
    }
  }
  return '';
}

// Parse name / property out of the email thread text. Lee's campaign template is
// "Hi {{first_name}}, still looking to sell {{property}}?" — that quoted outbound
// is included in the reply, so we can recover both even if Instantly has no data.
function parseFromThread(text) {
  const out = { name: '', property: '' };
  if (!text) return out;
  // Property: "...looking to sell <PROPERTY>?" or "...sell <PROPERTY> ?"
  let m = text.match(/sell\s+(.+?)\s*\?/i);
  if (m) out.property = m[1].replace(/\s+/g, ' ').trim();
  // Name: greeting like "Hi Thomas," / "Hello Thomas" / "Hey Thomas"
  m = text.match(/\b(?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear)\s+([A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+){0,2})\b/);
  if (m) out.name = m[1].trim();
  return out;
}

// Turn an email prefix like "thomasmontalbanoiii" into a best-guess display name
function looksLikeEmailPrefix(name, email) {
  if (!name || !email) return false;
  return /^[a-z0-9._]+$/i.test(name) && name.toLowerCase() === email.split('@')[0].toLowerCase();
}

// Find a single Instantly lead by email via the POST /leads/list search endpoint
async function findInstantlyLead(email) {
  if (!email) return null;
  try {
    const ld = await instantlyPost('leads/list', { search: email, limit: 10 });
    const items = ld.items || [];
    // Prefer an exact email match; otherwise take the first result
    return items.find(i => (i.email || '').toLowerCase() === email.toLowerCase()) || items[0] || null;
  } catch (e) {
    return null;
  }
}

async function pollInstantly() {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = await instantlyFetch(
      'emails?email_type=received&limit=100&sort_order=desc&min_timestamp_created=' + encodeURIComponent(since)
    );
    const items = result.items || [];
    const leads = await readLeads();
    let added = 0;
    for (const item of items) {
      const email = sanitizeEmail(item.lead || item.from_address_email || '');
      if (!email || isDuplicate(leads, email)) continue;
      let name = email.split('@')[0];
      let phone = '';
      let property = '';
      const li = await findInstantlyLead(email);
      if (li) {
        const fn = (li.first_name || '').trim();
        const ln = (li.last_name || '').trim();
        if (fn + ln) name = (fn + ' ' + ln).trim();
        phone = (li.phone || '').trim();
        property = extractProperty(li);
      }
      const replyText = (item.body && item.body.text) || item.content_preview || '';
      // Fallback: recover name/property from the email thread text
      const parsed = parseFromThread(replyText);
      if (!property && parsed.property) property = parsed.property;
      if (looksLikeEmailPrefix(name, email) && parsed.name) name = parsed.name;
      const lead = {
        id: 'lead_instantly_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        name, email, phone, property, source: 'Instantly', status: 'new',
        createdAt: Date.now(), calls: [],
        notes: replyText ? [{ at: Date.now(), text: replyText }] : [],
        followUpAt: null, emailSentAt: null,
      };
      await upsertLead(lead);
      leads.push(lead);
      added++;
      console.log('[Poll] Added: ' + name + ' <' + email + '>');
    }
    if (added) console.log('[Poll] Done ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ ' + added + ' new lead(s)');
  } catch (e) {
    console.error('[Poll] Error:', e.message);
  }
  // Self-heal any older leads that are still missing a real name or property
  await backfillLeads();
}

// Backfill name / phone / property on existing leads from their Instantly record.
// Runs automatically on startup and after each poll, so leads fix themselves.
async function backfillLeads() {
  try {
    const leads = await readLeads();
    const toFix = leads.filter(l =>
      (l.email && looksLikeEmailPrefix(l.name, l.email)) || !l.property
    );
    let fixed = 0;
    for (const lead of toFix) {
      try {
        const updated = { ...lead };
        let changed = false;
        const isPrefixName = looksLikeEmailPrefix(lead.name, lead.email);

        // 1) Try the Instantly lead record (real name / phone / property custom var)
        const li = lead.email ? await findInstantlyLead(lead.email) : null;
        if (li) {
          const fn = (li.first_name || '').trim();
          const ln = (li.last_name || '').trim();
          if (isPrefixName && (fn + ln)) { updated.name = (fn + ' ' + ln).trim(); changed = true; }
          if (!updated.property) {
            const prop = extractProperty(li);
            if (prop) { updated.property = prop; changed = true; }
          }
          if (!updated.phone && (li.phone || '').trim()) { updated.phone = li.phone.trim(); changed = true; }
        }

        // 2) Fallback: recover name/property from the stored email thread (notes)
        const noteText = (lead.notes || []).map(n => n.text).join('\n');
        const parsed = parseFromThread(noteText);
        if (!updated.property && parsed.property) { updated.property = parsed.property; changed = true; }
        if (looksLikeEmailPrefix(updated.name, updated.email) && parsed.name) {
          updated.name = parsed.name; changed = true;
        }

        if (changed) { await upsertLead(updated); fixed++; }
      } catch (e) {}
    }
    if (fixed) console.log('[Backfill] Updated ' + fixed + ' lead(s)');
    return fixed;
  } catch (e) {
    console.error('[Backfill] Error:', e.message);
    return 0;
  }
}


app.delete('/api/leads/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM leads WHERE id=$1', [req.params.id]);
    res.json({ status: 'deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One-time cleanup: clear bad emails containing template variables like {l.property}
app.post('/api/cleanup-emails', async (req, res) => {
  try {
    const leads = await readLeads();
    let fixed = 0;
    for (const l of leads) {
      if (l.email && /[{}]/.test(l.email)) {
        l.email = '';
        await upsertLead(l);
        fixed++;
        console.log('[Cleanup] Cleared bad email for lead:', l.id, l.name);
      }
    }
    res.json({ status: 'ok', fixed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// Ã¢ÂÂÃ¢ÂÂ Fix email-prefix names via Instantly Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
app.post('/api/fix-names', async (req, res) => {
  try {
    const fixed = await backfillLeads();
    res.json({ fixed });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Ã¢ÂÂÃ¢ÂÂ Delete lead Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
app.delete('/api/leads/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM leads WHERE id=$1', [req.params.id]);
    res.json({ status: 'deleted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function start() {
  await initDB();
  app.listen(PORT, () => console.log("Lee's Leads on port " + PORT));
  pollInstantly();
  setInterval(pollInstantly, POLL_INTERVAL_MS);
}
start();
