'use strict';
// Puts a few sample apps in the store on first run so it isn't empty.
const fs = require('fs');
const path = require('path');

const SAMPLES = [
  { file: 'star-catcher.html', name: 'Star Catcher', category: 'Games', icon: { type: 'emoji', emoji: '⭐', bg: '#1e1b4b' },
    tagline: 'Catch falling stars, dodge the rocks.',
    description: 'A quick arcade game for any screen. Slide the paddle with your mouse, finger or arrow keys to catch stars while avoiding rocks. It gets faster the longer you last — can you beat your best score?' },
  { file: 'notes.html', name: 'Quick Notes', category: 'Productivity', icon: { type: 'emoji', emoji: '📝', bg: '#facc15' },
    tagline: 'Jot it down. Saved automatically.',
    description: 'A simple sticky-notes board. Create notes, search them, and they are saved automatically on your device.' },
  { file: 'calculator.html', name: 'Calculator', category: 'Utilities', icon: { type: 'emoji', emoji: '🧮', bg: '#f59e0b' },
    tagline: 'A clean calculator with keyboard support.',
    description: 'Add, subtract, multiply, divide, percentages and sign flipping. Works with your keyboard too: type numbers and operators, Enter for equals, Esc to clear.' },
  { file: 'pixel-paint.html', name: 'Pixel Paint', category: 'Creativity', icon: { type: 'emoji', emoji: '🎨', bg: '#ec4899' },
    tagline: 'Draw 16×16 pixel art and save it as PNG.',
    description: 'Pick a color and drag across the grid to paint. Includes an eraser, fill, a custom color picker, and exporting your art as a PNG image. Your drawing is kept between visits.' },
  { file: 'focus-timer.html', name: 'Focus Timer', category: 'Productivity', icon: { type: 'emoji', emoji: '⏱️', bg: '#e11d48' },
    tagline: 'Focus for 25, rest for 5.',
    description: 'A focus timer using the classic work/break rhythm. Start a 25-minute focus session, then take a short or long break. Counts how many focus sessions you finish.' },
];

async function seed(db, { newId, now }) {
  const D = db.data;
  if (D.seeded) return;
  const team = { id: newId(), username: 'storeteam', displayName: 'Store Team', salt: null, passHash: null, createdAt: now() };
  D.users[team.id] = team;
  for (const [i, s] of SAMPLES.entries()) {
    const html = fs.readFileSync(path.join(__dirname, 'samples', s.file), 'utf8');
    const created = new Date(Date.now() - (SAMPLES.length - i) * 3600e3).toISOString();
    const app = {
      id: newId(), name: s.name, slug: s.file.replace('.html', ''), ownerId: team.id,
      tagline: s.tagline, description: s.description, category: s.category, icon: s.icon,
      currentVersion: '1.0.0',
      versions: [{ version: '1.0.0', notes: 'First release', createdAt: created, size: Buffer.byteLength(html) }],
      installs: 0, opens: 0, createdAt: created, updatedAt: created,
    };
    await db.writeCode(app.id, '1.0.0', html);
    D.apps[app.id] = app;
  }
  D.seeded = true;
  await db.flush();
}

module.exports = { seed };
