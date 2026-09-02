require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');

const demoProfiles = [
  { name: 'Ava', age: 26, gender: 'female', bio: 'Coffee snob. Weekend hiker. Always down for tacos.', job: 'Product Designer', location: 'Austin, TX', country: 'United States', interests: ['Hiking', 'Coffee', 'Design'], photos: ['https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=800'] },
  { name: 'Liam', age: 29, gender: 'male', bio: 'Guitarist trying not to talk about my band too much.', job: 'Software Engineer', location: 'Austin, TX', country: 'United States', interests: ['Music', 'Guitar', 'Gaming'], photos: ['https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=800'] },
  { name: 'Sophia', age: 24, gender: 'female', bio: 'Dog mom x2. Amateur baker. Professional overthinker.', job: 'Marketing Manager', location: 'Mumbai', country: 'India', interests: ['Baking', 'Dogs', 'Yoga'], photos: ['https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=800'] },
  { name: 'Noah', age: 31, gender: 'male', bio: 'Trail runner. Will talk your ear off about espresso.', job: 'Architect', location: 'Jaipur', country: 'India', interests: ['Running', 'Espresso', 'Travel'], photos: ['https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=800'] },
  { name: 'Mia', age: 27, gender: 'female', bio: 'Bookworm by day, karaoke villain by night.', job: 'Editor', location: 'London', country: 'United Kingdom', interests: ['Books', 'Karaoke', 'Wine'], photos: ['https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=800'] },
  { name: 'Ethan', age: 28, gender: 'male', bio: 'Building a startup. Building a better sourdough starter.', job: 'Founder', location: 'Toronto', country: 'Canada', interests: ['Startups', 'Baking', 'Cycling'], photos: ['https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=800'] },
];

async function run() {
  await db.init();
  const existing = await db.one('SELECT COUNT(*) as c FROM users');
  if (parseInt(existing.c, 10) > 0) {
    console.log(`Database already has ${existing.c} users. Skipping seed. Truncate the users table to reseed.`);
    process.exit(0);
  }

  const hash = bcrypt.hashSync('password123', 10);
  for (let i = 0; i < demoProfiles.length; i++) {
    const p = demoProfiles[i];
    await db.query(
      `INSERT INTO users (email, password_hash, auth_provider, name, age, gender, interested_in, bio, job, location, country, interests, photos, verified)
       VALUES ($1,$2,'local',$3,$4,$5,'everyone',$6,$7,$8,$9,$10,$11,true)`,
      [
        `demo${i + 1}@matchify.app`,
        hash,
        p.name,
        p.age,
        p.gender,
        p.bio,
        p.job,
        p.location,
        p.country,
        JSON.stringify(p.interests),
        JSON.stringify(p.photos),
      ]
    );
  }

  console.log(`Seeded ${demoProfiles.length} demo profiles.`);
  console.log('Each demo account login: demo1@matchify.app ... password123 (etc for demo2, demo3...)');
  process.exit(0);
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
