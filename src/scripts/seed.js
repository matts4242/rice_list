'use strict';

// Populate a development database with sample listings.
// Usage: npm run seed

const { getDb, closeDb } = require('../db');
const listings = require('../lib/listings');
const messages = require('../lib/messages');
const flags = require('../lib/flags');

const SAMPLES = [
  ['for-sale', 'Trek hybrid bike, 54cm frame', 32000, 'Riverside',
   'Trek FX 2 in good condition. Recently serviced with new brake pads and a fresh chain.\n\nComes with the rack and rear light. Selling because I moved somewhere much hillier and bought an e-bike.'],
  ['for-sale', 'Solid oak dining table, seats six', 18000, 'Northgate',
   'Heavy oak table, 180cm by 90cm. A few marks on the surface from ordinary use, structurally perfect.\n\nCollection only — it takes two people to move.'],
  ['housing', 'Sunny one-bed above the bakery', 115000, 'Old Town',
   'One bedroom flat available from next month. South facing, gets sun all afternoon.\n\nHeating and water included. No agency fees. Six or twelve month terms.'],
  ['housing', 'Room in a quiet three-bed share', 52000, 'Fairmount',
   'Double room in a shared house with two other people, both working weekdays.\n\nGarden, dishwasher, decent internet. Deposit is one month.'],
  ['jobs', 'Weekend barista, small independent cafe', null, 'Market Square',
   'Saturday and Sunday shifts, 7am to 2pm. Experience on an espresso machine preferred but we will train the right person.\n\nTips split evenly across the team.'],
  ['jobs', 'Part-time bookkeeper for a small builder', null, 'Remote',
   'About ten hours a month reconciling invoices and preparing quarterly returns.\n\nRemote is fine. Please mention which software you are comfortable with.'],
  ['services', 'Piano lessons, beginners welcome', 3500, 'Southside',
   'Classically trained, fifteen years of teaching. Lessons at my home studio or over video call.\n\nFirst lesson is half price so we can see if we get along.'],
  ['services', 'Bike repairs in your driveway', null, 'Citywide',
   'Mobile bike mechanic. Punctures, gears, brakes, full services.\n\nI come to you, usually same week. Message with your bike and the problem.'],
  ['community', 'Thursday evening football, players wanted', null, 'Meadow Park',
   'Friendly seven-a-side, 7pm on Thursdays. All abilities, no one keeps score too seriously.\n\nWe are short two players since the summer.'],
  ['free', 'Moving boxes, about twenty of them', 0, 'Riverside',
   'Sturdy double-walled boxes, all in one piece. Free to whoever can take the lot.\n\nAlso a roll and a half of bubble wrap.'],
  ['free', 'Upright piano, needs tuning', 0, 'Hillcrest',
   'Working upright piano, free to anyone who can move it. It has not been tuned in some years but every key sounds.\n\nIt is on the ground floor with easy access.'],
  ['wanted', 'Looking for a second-hand cargo bike', null, 'Anywhere nearby',
   'Long tail or box style, happy with something that needs a bit of work.\n\nBudget is flexible for the right one. Cash waiting.'],
];

function seed() {
  const db = getDb();
  const existing = db.prepare('SELECT count(*) AS total FROM listings').get().total;
  if (existing > 0) {
    console.log(`Database already has ${existing} listings. Nothing to seed.`);
    return;
  }

  const created = [];
  for (const [category, title, priceCents, location, description] of SAMPLES) {
    const result = listings.create({
      title,
      description,
      priceCents,
      category,
      location,
      contactEmail: `${category.replace(/-/g, '')}@example.com`,
      contactPhone: '',
      showPhone: false,
    });
    created.push(result);
  }

  // A little activity so the admin panel and inboxes have something to show.
  messages.create(created[0].listing.id, {
    senderName: 'Dana',
    senderEmail: 'dana@example.com',
    body: 'Is the bike still available? I could collect on Saturday morning.',
  });
  messages.create(created[0].listing.id, {
    senderName: 'Sam',
    senderEmail: 'sam@example.com',
    body: 'Would you take 280 for it? I can pay cash today.',
  });
  flags.create(created[5].listing.id, {
    reason: 'miscategorized',
    note: 'This reads more like a services ad than a job posting.',
  });

  console.log(`Seeded ${created.length} listings.`);
  console.log('Manage links (development only):');
  for (const { listing, manageToken } of created.slice(0, 3)) {
    console.log(`  ${listing.title}`);
    console.log(`    /listing/${listing.public_id}/manage?token=${manageToken}`);
  }
}

try {
  seed();
} finally {
  closeDb();
}
