/* PROTOTYPE — issue #9. Throwaway. Not production code, not tested, not shipped.
 *
 * Invented fixtures for the Beeper chat surface prototype. Every name, handle,
 * group, and message here is fabricated. No data from a live Beeper install may
 * ever enter this file (root AGENTS.md, Sensitive Data & Privacy).
 *
 * Scenarios exist because the development machine is NOT a representative
 * install (#9 comment): 9 networks there, 5 is today's free-tier cap, and 1 is
 * the shape most installs will actually have. A cross-network list is a very
 * different object at each of those, so the prototype must be judged at all
 * three, plus the degraded states.
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = Date.now();
const ago = (ms) => new Date(now - ms).toISOString();

// Letter glyphs, not brand logos — the prototype must not pull image assets, and
// the real implementation renders whatever GET /v1/accounts returns rather than
// a hardcoded list. This map is a fixture crutch only.
export const NETWORKS = {
  whatsapp: { label: 'WhatsApp', glyph: 'WA', tint: '#25D366' },
  googlemessages: { label: 'Google Messages', glyph: 'GM', tint: '#1A73E8' },
  discord: { label: 'Discord', glyph: 'DC', tint: '#5865F2' },
  telegram: { label: 'Telegram', glyph: 'TG', tint: '#29A9EB' },
  instagram: { label: 'Instagram', glyph: 'IG', tint: '#E1306C' },
  signal: { label: 'Signal', glyph: 'SG', tint: '#3A76F0' },
  slack: { label: 'Slack', glyph: 'SL', tint: '#E01E5A' },
  x: { label: 'X', glyph: 'X', tint: '#8E8E8E' },
  facebook: { label: 'Facebook', glyph: 'FB', tint: '#0866FF' },
};

export const networkLabel = (id) => NETWORKS[id]?.label || id;

const CONVERSATIONS = [
  {
    id: 'c1',
    network: 'whatsapp',
    title: 'Ada Lovelace',
    handle: '+61 4XX XXX XXX',
    group: false,
    unread: 2,
    muted: false,
    lastAt: ago(4 * MIN),
    preview: 'ok that works — 3pm your time?',
    direction: 'in',
    delivery: null,
  },
  {
    id: 'c2',
    network: 'discord',
    title: '#launch-planning',
    handle: 'Example Guild',
    space: 'Example Guild',
    group: true,
    unread: 17,
    muted: true,
    lastAt: ago(11 * MIN),
    preview: 'Bo Ramirez: pushed the build, someone sanity-check it',
    direction: 'in',
    delivery: null,
  },
  {
    id: 'c3',
    network: 'googlemessages',
    title: 'Cyd Nakamura',
    handle: '+61 4XX XXX XXX',
    group: false,
    unread: 0,
    muted: false,
    lastAt: ago(52 * MIN),
    preview: 'You: sent the invoice through',
    direction: 'out',
    delivery: 'read',
  },
  {
    id: 'c4',
    network: 'telegram',
    title: 'Delphine Roux',
    handle: '@delphine_example',
    group: false,
    unread: 1,
    muted: false,
    lastAt: ago(2 * HOUR),
    preview: 'the deadline moved, see attached',
    direction: 'in',
    delivery: null,
    attachment: true,
  },
  {
    id: 'c5',
    network: 'slack',
    title: 'Acme Corp — #general',
    handle: 'Acme Corp',
    space: 'Acme Corp',
    group: true,
    unread: 0,
    muted: false,
    lastAt: ago(3 * HOUR),
    preview: 'Erik Sandoval: standup notes are up',
    direction: 'in',
    delivery: null,
  },
  {
    id: 'c6',
    network: 'signal',
    title: 'Ada Lovelace',
    handle: '+61 4XX XXX XXX',
    group: false,
    unread: 0,
    muted: false,
    lastAt: ago(5 * HOUR),
    preview: 'You: will call after lunch',
    direction: 'out',
    delivery: 'delivered',
  },
  {
    id: 'c7',
    network: 'instagram',
    title: 'Fen Okonkwo',
    handle: '@fen.example',
    group: false,
    unread: 3,
    muted: false,
    lastAt: ago(8 * HOUR),
    preview: 'sent a reel',
    direction: 'in',
    delivery: null,
    attachment: true,
  },
  {
    id: 'c8',
    network: 'whatsapp',
    title: 'Saturday Rehearsal',
    handle: '6 participants',
    group: true,
    unread: 0,
    muted: true,
    lastAt: ago(1 * DAY),
    preview: 'Gita Varma: bringing the spare cable',
    direction: 'in',
    delivery: null,
  },
  {
    id: 'c9',
    network: 'x',
    title: 'Hal Brenner',
    handle: '@hal_example',
    group: false,
    unread: 0,
    muted: false,
    lastAt: ago(2 * DAY),
    preview: 'You: appreciated, thanks',
    direction: 'out',
    delivery: 'sent',
  },
  {
    id: 'c10',
    network: 'facebook',
    title: 'Ines Mbeki',
    handle: 'Ines Mbeki',
    group: false,
    unread: 0,
    muted: false,
    lastAt: ago(4 * DAY),
    preview: 'happy birthday!',
    direction: 'in',
    delivery: null,
  },
  {
    id: 'c11',
    network: 'discord',
    title: 'Jun Park',
    handle: 'junpark#0000',
    group: false,
    unread: 0,
    muted: false,
    lastAt: ago(6 * DAY),
    preview: 'You: yeah I saw, wild',
    direction: 'out',
    delivery: 'read',
  },
  {
    id: 'c12',
    network: 'telegram',
    title: 'Example Book Club',
    handle: '24 participants',
    group: true,
    unread: 0,
    muted: false,
    lastAt: ago(9 * DAY),
    preview: 'Kira Solberg: next pick is up to Ada',
    direction: 'in',
    delivery: null,
  },
];

// Threads keyed by conversation id. Only a few are filled in; the rest fall back
// to a generic shape. Enough to judge the thread view, not a full corpus.
const THREADS = {
  c1: [
    { id: 'm1', direction: 'in', at: ago(38 * MIN), text: 'morning — did the revised scope land?' },
    { id: 'm2', direction: 'out', at: ago(31 * MIN), text: 'yep, sent it about an hour ago. Two options in there.', delivery: 'read' },
    { id: 'm3', direction: 'in', at: ago(24 * MIN), text: 'reading now' },
    { id: 'm4', direction: 'in', at: ago(9 * MIN), text: 'option two, but can we push the call back?', replyTo: 'm2' },
    { id: 'm5', direction: 'in', at: ago(4 * MIN), text: 'ok that works — 3pm your time?' },
  ],
  c2: [
    { id: 'm1', direction: 'in', at: ago(2 * HOUR), sender: 'Bo Ramirez', text: 'branch is up for review' },
    { id: 'm2', direction: 'in', at: ago(90 * MIN), sender: 'Gita Varma', text: 'looking' },
    { id: 'm3', direction: 'out', at: ago(46 * MIN), text: 'left two comments, nothing blocking', delivery: 'sent' },
    { id: 'm4', direction: 'in', at: ago(11 * MIN), sender: 'Bo Ramirez', text: 'pushed the build, someone sanity-check it' },
  ],
  c4: [
    { id: 'm1', direction: 'in', at: ago(3 * HOUR), text: 'quick one before the weekend' },
    { id: 'm2', direction: 'in', at: ago(2 * HOUR), text: 'the deadline moved, see attached', attachment: 'revised-timeline.pdf' },
  ],
  c7: [
    { id: 'm1', direction: 'in', at: ago(9 * HOUR), text: 'sent a reel', attachment: 'shared-post.mp4' },
    { id: 'm2', direction: 'in', at: ago(8 * HOUR), text: 'thought of you' },
  ],
};

const genericThread = (conv) => [
  { id: 'g1', direction: 'in', at: new Date(new Date(conv.lastAt).getTime() - 2 * HOUR).toISOString(), sender: conv.group ? 'Kira Solberg' : undefined, text: 'earlier in this conversation' },
  { id: 'g2', direction: conv.direction, at: conv.lastAt, sender: conv.group && conv.direction === 'in' ? conv.preview.split(':')[0] : undefined, text: conv.preview.replace(/^You: /, '').replace(/^[^:]+: /, ''), delivery: conv.delivery },
];

export const threadFor = (conv) => (conv ? THREADS[conv.id] || genericThread(conv) : []);

export const SCENARIOS = [
  { id: 'nine', label: '9 networks (this dev machine — an outlier)' },
  { id: 'five', label: '5 networks (today’s free-tier cap)' },
  { id: 'one', label: '1 network (the common install)' },
  { id: 'empty', label: 'Connected, no history yet' },
  { id: 'backfill', label: 'Backfill in progress' },
  { id: 'degraded', label: 'One bridge disconnected' },
  { id: 'offline', label: 'Beeper API unreachable' },
];

const NINE = Object.keys(NETWORKS);
const FIVE = ['whatsapp', 'googlemessages', 'discord', 'telegram', 'signal'];
const ONE = ['whatsapp'];

const accountsFor = (ids, downId) => ids.map((id) => ({
  id: `acct_${id}`,
  network: id,
  label: NETWORKS[id].label,
  // Sentinel discipline (root AGENTS.md): a bridge that is reachable-but-broken
  // is a third state, never folded into "connected" or "absent".
  state: id === downId ? 'disconnected' : 'connected',
  statusText: id === downId ? 'Bridge lost its session — reconnect in Beeper' : null,
}));

const convsFor = (ids) => CONVERSATIONS.filter((c) => ids.includes(c.network));

export function buildScenario(id) {
  switch (id) {
    case 'five':
      return { reachable: true, accounts: accountsFor(FIVE), conversations: convsFor(FIVE), backfilling: false };
    case 'one':
      return { reachable: true, accounts: accountsFor(ONE), conversations: convsFor(ONE), backfilling: false };
    case 'empty':
      return { reachable: true, accounts: accountsFor(FIVE), conversations: [], backfilling: false };
    case 'backfill':
      return { reachable: true, accounts: accountsFor(FIVE), conversations: convsFor(FIVE).slice(0, 2), backfilling: true };
    case 'degraded':
      return { reachable: true, accounts: accountsFor(NINE, 'telegram'), conversations: convsFor(NINE), backfilling: false };
    case 'offline':
      return { reachable: false, accounts: [], conversations: [], backfilling: false };
    case 'nine':
    default:
      return { reachable: true, accounts: accountsFor(NINE), conversations: convsFor(NINE), backfilling: false };
  }
}
