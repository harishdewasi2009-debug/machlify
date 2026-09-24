// Deterministic generator for FICTIONAL demo profiles (development/staging only).
// No real people, no scraped photos — avatars are CC0 illustrations rendered by DiceBear.
const { CITIES } = require('./cities');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const FEMALE = 'Aanya Aditi Ananya Avni Diya Ishita Kavya Meera Nisha Priya Riya Saanvi Sneha Tanvi Zoya Pooja Neha Shreya Kritika Mahi Naina Ira Jiya Kiara Myra Navya Pari Rhea Sara Trisha Vanya Anika Bhavya Charvi Disha Esha Gauri Hiral Isha Janvi Khushi Lavanya Mansi Nandini Palak Radhika Simran Tara Uma Vidya Yamini Aarohi Bela Chitra Devika Harini Indira Juhi'.split(' ');
const MALE = 'Aarav Aditya Arjun Dev Ishaan Karan Kabir Rohan Rahul Siddharth Vihaan Vivaan Yash Aryan Dhruv Harsh Krish Manav Nikhil Pranav Raghav Sahil Tanmay Utkarsh Varun Kunal Amit Anmol Bhavesh Chirag Dinesh Gaurav Hemant Jay Kartik Lakshya Mohit Naveen Omkar Parth Rishabh Samar Tushar Uday Vikram Yuvraj Abhay Bharat Deepak Eshan Farhan Gautam'.split(' ');
const JOBS = ['Software Engineer', 'Product Designer', 'Doctor', 'Teacher', 'Chartered Accountant', 'Photographer', 'Content Creator', 'Marketing Manager', 'Architect', 'Data Analyst', 'Lawyer', 'Entrepreneur', 'Nurse', 'Chef', 'Journalist', 'Musician', 'Fitness Coach', 'Research Scholar', 'Financial Analyst', 'Fashion Designer', 'Pilot', 'Banker', 'UX Researcher', 'Freelance Writer', 'Civil Engineer', 'HR Manager', 'Student'];
const INTERESTS = ['Travel', 'Trekking', 'Cricket', 'Football', 'Badminton', 'Yoga', 'Gym', 'Running', 'Cycling', 'Photography', 'Cooking', 'Baking', 'Street food', 'Coffee', 'Chai', 'Books', 'Poetry', 'Movies', 'Web series', 'Anime', 'Gaming', 'Music', 'Guitar', 'Singing', 'Dancing', 'Painting', 'Sketching', 'Fashion', 'Thrifting', 'Meditation', 'Podcasts', 'Stand-up comedy', 'Theatre', 'Board games', 'Road trips', 'Beaches', 'Mountains', 'Camping', 'Dogs', 'Cats', 'Gardening', 'Volunteering', 'Startups', 'Investing', 'Tech', 'Architecture', 'History', 'Languages', 'Karaoke', 'Bollywood', 'Indie music', 'Food blogging', 'Chess', 'Swimming', 'DIY', 'Sustainability'];
const OPENERS = ['Coffee first, opinions later.', 'Professional overthinker, amateur chef.', 'Weekend person trapped in a weekday schedule.', 'Here for good conversations and better snacks.', 'Curious about almost everything.', 'Low-key introvert, high-key foodie.', 'Always up for a spontaneous plan.', 'Believer in long walks and longer chats.', 'Trying to be the person my dog thinks I am.', 'Fluent in sarcasm and Hindi film dialogues.'];
const CLOSERS = ['Say hi — I reply faster than you think.', 'Tell me your best recommendation.', 'Looking for someone who laughs easily.', 'Let\'s see where a good chat goes.', 'Bonus points if you can beat me at Ludo.', 'Ask me about my last trip.', 'No pressure, just good vibes.'];
const PROMPT_ANSWERS = {
  ideal_sunday: ['Late brunch, a long walk and a book.', 'Cricket on TV and biryani, no negotiations.', 'Farmers market, then cooking something ambitious.'],
  two_truths: ['I have visited 12 states, I can juggle, and I have never seen a Bond film.', 'I speak three languages, I hate mangoes (shocking), and I once ran a 10K.'],
  looking_for: ['Someone kind, curious and good at planning trips.', 'A best friend who happens to be a great date.', 'Real conversations, no games.'],
  perfect_first_date: ['Chai at a quiet café, then a walk if it\'s going well.', 'Street food crawl — you pick the first stop.', 'A bookstore and a very serious discussion about the best fiction.'],
  unpopular_opinion: ['Pineapple on pizza is fine.', 'Rainy days beat sunny days.', 'Group chats should have office hours.'],
  cant_live_without: ['Filter coffee and a good playlist.', 'My headphones and morning sunlight.', 'Chai. That is the entire answer.'],
  best_travel_story: ['Missed a train in Jaipur and ended up at a wedding.', 'Got lost in Munnar and found the best tea stall.'],
  weekend_spot: ['That one rooftop café with terrible wifi and great sunsets.', 'Any trail within two hours of the city.'],
  green_flag: ['Texts back when they say they will.', 'Kind to waiters and to cab drivers.'],
  ask_me_about: ['My 5 AM running streak.', 'The time I cooked for 20 people by accident.', 'My unreasonable love for old Hindi songs.'],
};
const INTENTS = [['long_term', 40], ['figuring_out', 20], ['marriage', 15], ['short_term', 10], ['friends', 15]];

function pickWeighted(rng, pairs) {
  const total = pairs.reduce((s, p) => s + p[1], 0); let r = rng() * total;
  for (const [v, w] of pairs) { r -= w; if (r <= 0) return v; }
  return pairs[pairs.length - 1][0];
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
function sample(rng, arr, n) { const a = [...arr]; const out = []; while (out.length < n && a.length) out.push(a.splice(Math.floor(rng() * a.length), 1)[0]); return out; }
function normal(rng, mean, sd) { const u = 1 - rng(), v = rng(); return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

function generateProfiles({ count = 900, female = Math.floor(count / 2), seed = 20260921, batch = 'demo' } = {}) {
  const rng = mulberry32(seed);
  const out = [];
  const cityPairs = CITIES.map((c) => [c, c.w]);
  const genders = [...Array(Math.min(female, count)).fill('woman'), ...Array(Math.max(0, count - female)).fill('man')];
  // deterministic shuffle so genders are interleaved
  for (let i = genders.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [genders[i], genders[j]] = [genders[j], genders[i]]; }

  for (let i = 0; i < count; i++) {
    const gender = genders[i];
    const age = Math.max(18, Math.min(45, Math.round(normal(rng, 27, 5))));
    const year = new Date().getUTCFullYear() - age;
    const dob = new Date(Date.UTC(year, Math.floor(rng() * 12), 1 + Math.floor(rng() * 28)));
    if (dob > new Date(Date.UTC(new Date().getUTCFullYear() - age, new Date().getUTCMonth(), new Date().getUTCDate()))) dob.setUTCFullYear(year - 1); // guarantee age >= target
    const city = pickWeighted(rng, cityPairs);
    const interests = sample(rng, INTERESTS, 3 + Math.floor(rng() * 6));
    const bio = `${pick(rng, OPENERS)} Into ${interests.slice(0, 3).join(', ').toLowerCase()}. ${pick(rng, CLOSERS)}`;
    const promptKeys = sample(rng, Object.keys(PROMPT_ANSWERS), 1 + Math.floor(rng() * 3));
    const hoursAgo = Math.min(720, -Math.log(1 - rng()) * 60);          // exponential: most people active recently
    const createdDays = rng() < 0.15 ? rng() * 13 : 14 + rng() * 106;   // ~15% are "new users"
    const prefGenders = rng() < 0.08 ? [] : gender === 'woman' ? (rng() < 0.9 ? ['man'] : ['woman']) : (rng() < 0.9 ? ['woman'] : ['man']);
    const n = String(i + 1).padStart(4, '0');
    out.push({
      email: `demo${n}@demo.matchify.invalid`,
      name: pick(rng, gender === 'woman' ? FEMALE : MALE),
      gender, age, dob: dob.toISOString().slice(0, 10),
      bio, job: pick(rng, JOBS), location: city.name, country: 'India',
      lat: Math.round((city.lat + (rng() - 0.5) * 0.16) * 100) / 100, lng: Math.round((city.lng + (rng() - 0.5) * 0.16) * 100) / 100,
      interests, relationshipIntent: pickWeighted(rng, INTENTS),
      heightCm: Math.round(gender === 'woman' ? 152 + rng() * 23 : 165 + rng() * 25),
      prefGenders, prefAgeMin: Math.max(18, age - 6), prefAgeMax: Math.min(60, age + 10), prefDistanceKm: 25 + Math.floor(rng() * 176),
      photoVerified: rng() < 0.3, hoursAgo, createdDaysAgo: createdDays,
      prompts: promptKeys.map((k) => ({ key: k, answer: pick(rng, PROMPT_ANSWERS[k]) })),
      photos: [`/demo-avatars/lorelei/${batch}-${n}-a.svg`, `/demo-avatars/lorelei/${batch}-${n}-b.svg`],
    });
  }
  return out;
}

module.exports = { generateProfiles, mulberry32 };
