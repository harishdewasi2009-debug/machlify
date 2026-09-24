#!/usr/bin/env node
// Development/staging seed: 900 clearly-marked FICTIONAL profiles.
//   npm run seed:demo                       create 900 (450 women-presenting / 450 men-presenting)
//   npm run seed:demo -- --count=300 --female=150
//   npm run seed:demo -- --dry-run          print a summary, write nothing
//   npm run seed:demo -- --delete           remove every demo profile and its dependent rows
//   npm run seed:demo -- --reset            delete, then re-create
// Demo rows: is_demo=true, email @demo.matchify.invalid, NO password (cannot log in), never
// shown when NODE_ENV=production (see lib/visibility.js). No swipes/likes/matches/messages are created.
require('dotenv').config();
const { generateProfiles } = require('../lib/demoData');
const { computeStrength } = require('../services/profile');

const DEMO_WHERE = `is_demo = true AND email LIKE '%@demo.matchify.invalid'`;

async function deleteDemo(db) {
  const r = await db.query(`DELETE FROM users WHERE ${DEMO_WHERE}`);
  return r.rowCount;
}

async function seedDemo(db, { count = 900, female, seed = 20260921, batch, dryRun = false, log = () => {} } = {}) {
  const cfg = require('../config');
  if (cfg.isProd()) throw new Error('Refusing to seed demo profiles when NODE_ENV=production.');
  const existing = Number((await db.query(`SELECT COUNT(*) c FROM users WHERE ${DEMO_WHERE}`)).rows[0].c);
  if (existing > 0) throw new Error(`${existing} demo profiles already exist. Use --reset to recreate them or --delete to remove them.`);
  batch = batch || `d${seed % 100000}`;
  const profiles = generateProfiles({ count, female: female ?? Math.floor(count / 2), seed, batch });
  if (dryRun) return { created: 0, wouldCreate: profiles.length };

  const CH = 100;
  for (let i = 0; i < profiles.length; i += CH) {
    const chunk = profiles.slice(i, i + CH);
    const vals = []; const params = [];
    const p = (v) => { params.push(v); return `$${params.length}`; };
    for (const d of chunk) {
      const tags = d.interests.map((s) => s.toLowerCase());
      const strength = computeStrength({ bio: d.bio, interest_tags: tags, job: d.job, location: d.location, relationship_intent: d.relationshipIntent }, d.photos.length, d.prompts.length);
      vals.push(`(${[
        p(d.email), p('demo'), p(d.name), p(d.dob), p(d.age), p(d.gender), p(d.prefGenders.length === 1 ? (d.prefGenders[0] === 'woman' ? 'women' : 'men') : 'everyone'),
        p(d.bio), p(d.job), p(d.location), p(d.country), p(d.lat), p(d.lng), p(JSON.stringify(d.interests)), p(tags), p(JSON.stringify(d.photos)),
        p(d.prefGenders), p(d.prefAgeMin), p(d.prefAgeMax), p(d.prefDistanceKm), p(d.relationshipIntent), p(d.heightCm), p(d.photoVerified), p(strength), p(batch),
        `NOW() - (${p(String(d.hoursAgo))} || ' hours')::interval`, `NOW() - (${p(String(d.createdDaysAgo))} || ' days')::interval`,
        "true", "'verified'", "true", "NOW()", "NULL", "false",
      ].join(',')})`);
    }
    const res = await db.query(
      `INSERT INTO users (email, auth_provider, name, dob, age, gender, interested_in, bio, job, location, country, lat, lng, interests, interest_tags, photos,
                          pref_genders, pref_age_min, pref_age_max, pref_distance_km, relationship_intent, height_cm, photo_verified, profile_strength, demo_batch,
                          last_active_at, created_at, is_demo, verification_status, over_18, tos_accepted_at, password_hash, verified)
       VALUES ${vals.join(',')} RETURNING id, email`, params);
    const idByEmail = new Map(res.rows.map((r) => [r.email, r.id]));
    const ph = { u: [], url: [], pos: [] }; const pr = { u: [], k: [], a: [], pos: [] };
    for (const d of chunk) {
      const id = idByEmail.get(d.email);
      d.photos.forEach((url, pos) => { ph.u.push(id); ph.url.push(url); ph.pos.push(pos); });
      d.prompts.forEach((x, pos) => { pr.u.push(id); pr.k.push(x.key); pr.a.push(x.answer); pr.pos.push(pos); });
    }
    await db.query(`INSERT INTO photos (user_id, url, thumb_url, position, status, moderation)
                    SELECT u, url, url, pos, 'approved', '{"demo":true}'::jsonb FROM unnest($1::int[], $2::text[], $3::int[]) AS t(u, url, pos)`, [ph.u, ph.url, ph.pos]);
    await db.query(`INSERT INTO profile_prompts (user_id, prompt_key, answer, position) SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::int[])`, [pr.u, pr.k, pr.a, pr.pos]);
    log(`inserted ${Math.min(i + CH, profiles.length)}/${profiles.length}`);
  }
  return { created: profiles.length, batch };
}

module.exports = { seedDemo, deleteDemo, DEMO_WHERE };

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v === undefined ? true : v]; }));
  const { pool } = require('../db');
  const { migrate } = require('../migrate');
  (async () => {
    await migrate(pool, { log: () => {} });
    const db = { query: (t, p) => pool.query(t, p) };
    if (args.delete || args.reset) { const n = await deleteDemo(db); console.log(`Deleted ${n} demo profiles.`); if (args.delete) return; }
    const r = await seedDemo(db, { count: parseInt(args.count, 10) || 900, female: args.female !== undefined ? parseInt(args.female, 10) : undefined, seed: args.seed ? parseInt(args.seed, 10) : undefined, dryRun: !!args['dry-run'], log: console.log });
    console.log(r.wouldCreate !== undefined ? `Dry run: would create ${r.wouldCreate} demo profiles.` : `Created ${r.created} demo profiles (batch ${r.batch}). Set DEMO_MODE=true (non-production only) to see them in Discover.`);
  })().then(() => pool.end()).catch((e) => { console.error(e.message); pool.end().then(() => process.exit(1)); });
}
