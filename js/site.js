// Where this copy of the site lives and how it pays for itself. One file to edit; nothing else names an owner.
// Every slot is off until its value is filled in, and a slot that is off draws nothing on the page.

export const SITE = {
  name: 'The Price of Pace',
  tagline: 'College basketball live totals, measured against a fair number',

  // Address the recorder's files are served from, ending in a slash.
  // Empty: worked out from a github.io address, which is all a site without its own domain needs.
  data: 'https://raw.githubusercontent.com/priceofpace1/cold-stretch-live/data/',

  // Public link to the code and recorded data. Empty: no link is shown.
  source: '',

  // Contact address shown on the About page, for example hello@example.com. Empty: none shown.
  contact: '',

  // Cloudflare Web Analytics token. Counts visits without cookies. Empty: nothing is loaded.
  analytics: '',

  // Email list. `action` is the address the provider gives for a plain HTML form; `field` is the name it expects
  // for the email input. Empty action: the signup box is not drawn.
  newsletter: {
    action: '',
    field: 'email',
    pitch: 'One short email on game days: the slate, any signals, and the running record.',
  },

  // Sportsbook referral link, shown beside a live signal. Empty url: no link is drawn and the About page says the
  // site carries no paid links. Take flat per-signup terms only; the disclosure on the About page says so.
  book: { name: '', url: '' },
};

/** The recorder's base address: an explicit ?data= wins, then the config, then a github.io address, then a local folder. */
export function dataBase(loc = globalThis.location, site = SITE) {
  const slash = (u) => u.replace(/\/?$/, '/');
  const q = new URLSearchParams(loc.search || '').get('data');
  if (q) return slash(q);
  if (site.data) return slash(site.data);
  const m = /^(.+)\.github\.io$/.exec(loc.hostname || ''), repo = (loc.pathname || '').split('/')[1];
  return m && repo ? `https://raw.githubusercontent.com/${m[1]}/${repo}/data/` : 'data/';
}

/** Only https links leave the site, and only a real-looking address is offered for mail. */
export const safeLink = (u) => (/^https:\/\/[^\s"'<>]+$/.test(u || '') ? u : '');
export const safeMail = (a) => (/^[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}$/i.test(a || '') ? a : '');
