// Run this once to push all leads to the live server:
// node seed-remote.js

const https = require('https');

const SERVER = 'lees-leads-production.up.railway.app';

const leads = [
  {name:'Chris Calderbank',email:'chrisc96@comcast.net',phone:'609-502-5826',property:'Delray Beach',source:'Instantly',status:'followup',note:'Yes. Still selling. If you have a buyer call Staci Samuals.'},
  {name:'Juan Rios',email:'jriosborges@gmail.com',phone:'305-904-9804',property:'Hallandale Beach',source:'Instantly',status:'new',note:'Yes, still looking.'},
  {name:'Julia Amsterdam',email:'juliaamsterdam23@gmail.com',phone:'860-212-5129',property:'Boynton Beach',source:'Instantly',status:'new',note:"Why didn't you bring your buyers by when the property was listed?"},
  {name:'Reilly Shaughnessy',email:'reilshaughn@gmail.com',phone:'619-673-5333',property:'Hutchinson Island',source:'Instantly',status:'followup',note:'Hi Lee Wendy Franco is our agent so please contact her.'},
  {name:'Justo Felix',email:'justofelix17@icloud.com',phone:'760-600-4083',property:'Southwest Ranches',source:'Instantly',status:'called',note:'Yes – called'},
  {name:'Michael Weiss',email:'wmiweiss@gmail.com',phone:'917-673-4898',property:'West Palm Beach',source:'Instantly',status:'new',note:'If you have specific buyer, please call me at 845-537-6253.'},
  {name:'Edward Gelin',email:'edwardgelin0300@gmail.com',phone:'410-598-2900',property:'Jupiter',source:'Instantly',status:'new',note:"So why haven't u sold it???"},
  {name:'maguchal986',email:'maguchal986@gmail.com',phone:'',property:'Pembroke Pines',source:'Instantly',status:'new',note:'Yes, we are still interested.'},
  {name:'Russell Erickson',email:'s38boat@comcast.net',phone:'561-801-3125',property:'Cape Coral',source:'Instantly',status:'followup',note:"I'm waiting 31 days to reset the MLS but it's still for sale."},
  {name:'Michael Ballentine',email:'',phone:'',property:'Atlantis',source:'Instantly',status:'closed',note:'No longer owns the property. Son David is the owner.'},
  {name:'tlopez711',email:'tlopez711@yahoo.com',phone:'',property:'Sunrise',source:'Instantly',status:'new',note:'Hi Can I call you? Need a number.'},
  {name:'Jorge Benitez',email:'jorgebntz7@gmail.com',phone:'786-262-3526',property:'Hialeah',source:'Instantly',status:'followup',note:'I took it off the market. Have folks that would buy it.'},
  {name:'juditturner',email:'juditturner@hotmail.com',phone:'',property:'Fort Lauderdale',source:'Instantly',status:'followup',note:'It has been rented for a year.'},
  {name:'chuadonga',email:'chuadonga@comcast.net',phone:'',property:'Plantation',source:'Instantly',status:'new',note:'Yes. Bring me a buyer.'},
  {name:'Arthur Goldblatt',email:'aggap@aol.com',phone:'310-422-3116',property:'Miami',source:'Instantly',status:'followup',note:'Hi Lee, I responded to you on Friday.'},
  {name:'Rebecca DiPietro',email:'rebeccadipietro79@gmail.com',phone:'502-377-0444',property:'Hypoluxo',source:'Instantly',status:'followup',note:'The condo is still for sale. If you come across a buyer…'},
  {name:'Jose Pernalete',email:'sinestres2010@gmail.com',phone:'305-878-9197',property:'North Miami Beach',source:'Instantly',status:'followup',note:'SEND ME A SERIOUS BUYER FOR THAT PROPERTY.'},
  {name:'centronet',email:'centronet@hotmail.com',phone:'',property:'Port St. Lucie',source:'Instantly',status:'closed',note:"HI I'M THE LISTING AGENT – not the owner."},
  {name:'Linda Polish',email:'linda.polish@gmail.com',phone:'561-389-1529',property:'Wellington',source:'Instantly',status:'followup',note:"My house is in litigation. The people in there don't want to leave."},
  {name:'Alan Levin',email:'alanlevin@gmail.com',phone:'708-205-2778',property:'Delray Beach',source:'Instantly',status:'new',note:'Considering…'},
  {name:'suntantasinflorida',email:'suntantasinflorida@gmail.com',phone:'',property:'Port St. Lucie',source:'Instantly',status:'followup',note:'Owner Broker agent – firm on price!'},
  {name:'Guy Tenenbaum',email:'guytenenbaum@gmail.com',phone:'305-776-2428',property:'Jupiter (Ranch Colony)',source:'Instantly',status:'called',note:'Yes, we are still interested. Price?'},
];

function post(lead) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      name: lead.name, email: lead.email, phone: lead.phone,
      property: lead.property, source: lead.source, status: lead.status,
    });
    const req = https.request({
      hostname: SERVER, path: '/api/leads', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      res.on('data', () => {});
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          console.log(`✓ ${lead.name}`);
        } else if (res.statusCode === 409) {
          console.log(`  skip (duplicate): ${lead.name}`);
        } else {
          console.log(`  ? ${lead.name} (${res.statusCode})`);
        }
        resolve();
      });
    });
    req.on('error', e => { console.log(`  error: ${lead.name} — ${e.message}`); resolve(); });
    req.write(body);
    req.end();
  });
}

async function run() {
  console.log(`Seeding ${leads.length} leads to ${SERVER}...\n`);
  for (const lead of leads) await post(lead);
  console.log('\nDone! Refresh Lee\'s Leads to see them.');
}

run();
