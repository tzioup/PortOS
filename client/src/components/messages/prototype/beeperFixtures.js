/* PROTOTYPE — issue #9. Throwaway.
 *
 * Invented fixtures shaped to match the REFERENCE INTERFACE (Beeper Desktop),
 * observed from the principal's screenshots. Every name, handle, group, server,
 * and message here is fabricated — no data from the live install may enter this
 * file (root AGENTS.md, Sensitive Data & Privacy).
 *
 * The row anatomy below is copied from the reference, not designed:
 *   avatar + network badge bottom-right · title · muted bell inline after title
 *   · right-aligned timestamp · preview with a leading state chip · unread as a
 *   NUMBER PILL, or a bare DOT (unread, count withheld), or nothing.
 *
 * Scenarios exist because the development machine is NOT a representative
 * install (#9): 9 networks there, 5 is today's free-tier cap, 1 is what most
 * installs will have. Beeper Desktop cannot show us those, which is the one
 * thing this prototype adds over just looking at the real client.
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = Date.now();
const ago = (ms) => new Date(now - ms).toISOString();

// Letter glyphs, not brand logos: the prototype pulls no image assets, and the
// real implementation renders whatever GET /v1/accounts returns rather than a
// hardcoded list. This map is a fixture crutch only.
export const NETWORKS = {
  whatsapp: { label: 'WhatsApp', glyph: 'WA', tint: '#25D366' },
  googlemessages: { label: 'Google Messages', glyph: 'GM', tint: '#1A73E8', transport: 'RCS' },
  discord: { label: 'Discord', glyph: 'DC', tint: '#5865F2' },
  telegram: { label: 'Telegram', glyph: 'TG', tint: '#29A9EB' },
  instagram: { label: 'Instagram', glyph: 'IG', tint: '#E1306C' },
  signal: { label: 'Signal', glyph: 'SG', tint: '#3A76F0' },
  slack: { label: 'Slack', glyph: 'SL', tint: '#E01E5A' },
  x: { label: 'X', glyph: 'X', tint: '#8E8E8E' },
  facebook: { label: 'Facebook', glyph: 'FB', tint: '#0866FF' },
};

export const networkLabel = (id) => NETWORKS[id]?.label || id;

/** How the reference names the send target: network, plus transport where the
 *  network has one. Observed verbatim as "Message <name> on Google Messages (RCS)". */
export const sendTargetLabel = (network) => {
  const net = NETWORKS[network];
  if (!net) return network;
  return net.transport ? `${net.label} (${net.transport})` : net.label;
};

const CONVERSATIONS = [
  {
    id: 'c1',
    network: 'telegram',
    title: 'Dee Dee Example',
    handle: '@dee_example',
    unread: 1,
    muted: true,
    lastAt: ago(9 * MIN),
    preview: 'Dee: New voicemail',
    lead: 'group',
  },
  {
    id: 'c2',
    network: 'whatsapp',
    title: 'Bro',
    handle: '+61 4XX XXX XXX',
    unread: 1,
    lastAt: ago(31 * MIN),
    preview: 'loved “Coucou I’ll come by later”',
  },
  {
    id: 'c3',
    network: 'whatsapp',
    title: 'Example Production Notes',
    handle: '12 participants',
    group: true,
    unread: 2,
    muted: true,
    lastAt: ago(2 * HOUR),
    preview: 'Anna: Thank you! I will…',
    lead: 'group',
  },
  {
    id: 'c4',
    network: 'googlemessages',
    title: 'Parcel Tracking',
    handle: '+61 4XX XXX XXX',
    unread: 5,
    lastAt: ago(2.5 * HOUR),
    preview: 'Your parcel 0620XXXXX is out for delivery',
  },
  {
    id: 'c5',
    network: 'telegram',
    title: 'Example Bot',
    handle: '@example_bot',
    unread: 0,
    muted: true,
    lastAt: ago(3 * HOUR),
    preview: 'Done! Configuration saved.',
    lead: 'bot',
  },
  {
    id: 'c6',
    network: 'signal',
    title: 'Juliette Example',
    handle: '+33 6 XX XX XX XX',
    unread: 1,
    lastAt: ago(9 * HOUR),
    preview: 'Ok. Did you like it?',
    lead: 'image',
  },
  {
    id: 'c7',
    network: 'googlemessages',
    title: 'Hippolyte Example',
    handle: '+33 6 XX XX XX XX',
    unread: 0,
    lastAt: ago(1 * DAY),
    preview: 'name@example.com',
    direction: 'out',
    delivery: 'read',
  },
  {
    id: 'c8',
    network: 'instagram',
    title: 'Vee P',
    handle: '@vee.example',
    unread: 0,
    lastAt: ago(1.2 * DAY),
    preview: 'Sorry! 🍪🍪',
  },
  {
    id: 'c9',
    network: 'facebook',
    title: 'Jacques Example',
    handle: 'Jacques Example',
    unread: 0,
    lastAt: ago(1.4 * DAY),
    preview: 'I hear you!',
    direction: 'out',
    delivery: 'read',
  },
  {
    id: 'c10',
    network: 'x',
    title: 'JTExample45',
    handle: '@jtexample45',
    unread: 0,
    lastAt: ago(1.6 * DAY),
    preview: 'Righty-o I’ll just try that',
    direction: 'out',
    delivery: 'read',
  },
  {
    id: 'c11',
    network: 'signal',
    title: 'Rebecca Example',
    handle: '+61 4XX XXX XXX',
    // The reference shows a bare DOT here rather than a count: unread, count
    // withheld. A third state the store has to be able to represent.
    unread: 0,
    unreadDot: true,
    muted: true,
    lastAt: ago(3 * DAY),
    preview: 'Talk soon',
  },
  {
    id: 'c12',
    network: 'whatsapp',
    title: '+61 4XX XXX XXX',
    handle: 'not in contacts',
    unread: 0,
    unreadDot: true,
    lastAt: ago(3.1 * DAY),
    preview: 'Hi Leo, following up on the quote',
  },
  {
    id: 'c13',
    network: 'discord',
    title: '#build-alerts',
    // The reference renders a server channel as "#channel • Server (Discord)".
    // A network is NOT the finest grain that exists — see the note on #7.
    space: 'Example Guild',
    handle: 'Example Guild',
    group: true,
    unread: 0,
    lastAt: ago(4 * DAY),
    preview: 'CI: build-5521 failed on main',
    lead: 'bot',
  },
  {
    id: 'c14',
    network: 'slack',
    title: '#general',
    space: 'Acme Corp',
    handle: 'Acme Corp',
    group: true,
    unread: 6,
    lastAt: ago(5 * DAY),
    preview: 'Erik: standup notes are up',
    lead: 'group',
  },
];

const THREADS = {
  c13: [
    { id: 'm1', at: ago(6 * DAY), sender: 'CI Bot', text: 'build-5518 passed on main', mono: true },
    { id: 'm2', at: ago(5 * DAY), sender: 'CI Bot', deleted: true },
    { id: 'm3', at: ago(4.4 * DAY), sender: 'CI Bot', text: 'build-5521 failed on main\n\nstage: integration\nbranch: main\nattempt 1', mono: true },
    { id: 'm4', at: ago(4.2 * DAY), direction: 'out', text: 'looking now', delivery: 'sent' },
    { id: 'm5', at: ago(4 * DAY), sender: 'CI Bot', deleted: true },
  ],
  c2: [
    { id: 'm1', at: ago(3 * HOUR), text: 'you around this arvo?' },
    { id: 'm2', at: ago(2 * HOUR), direction: 'out', text: 'from about 3, yeah', delivery: 'read' },
    { id: 'm3', at: ago(31 * MIN), text: 'loved “Coucou I’ll come by later”', reaction: '❤️' },
  ],
  c6: [
    { id: 'm1', at: ago(10 * HOUR), text: 'sent a photo', attachment: 'photo.jpg' },
    { id: 'm2', at: ago(9 * HOUR), text: 'Ok. Did you like it?' },
  ],
};

const genericThread = (conv) => [
  { id: 'g1', at: new Date(new Date(conv.lastAt).getTime() - 2 * HOUR).toISOString(), sender: conv.group ? 'Kira Example' : undefined, text: 'earlier in this conversation' },
  {
    id: 'g2',
    at: conv.lastAt,
    direction: conv.direction,
    sender: conv.group && conv.direction !== 'out' ? conv.preview.split(':')[0] : undefined,
    text: conv.preview.replace(/^[^:]+: /, ''),
    delivery: conv.delivery,
  },
];

export const threadFor = (conv) => (conv ? THREADS[conv.id] || genericThread(conv) : []);

/* The rail's fixed top group, above the per-network scopes. Reproduced from the
 * reference so the shape is judged as a whole; only Inbox is wired, the rest are
 * out of the MVP and rendered inert so their absence can be argued for. */
export const SYSTEM_SCOPES = [
  { id: 'inbox', label: 'Inbox', icon: 'inbox', live: true },
  { id: 'archive', label: 'Archive', icon: 'archive' },
  { id: 'requests', label: 'Requests', icon: 'mail', dot: true },
  { id: 'lowpriority', label: 'Low priority', icon: 'tray' },
  { id: 'later', label: 'Later', icon: 'clock' },
];

export const SCENARIOS = [
  { id: 'nine', label: '9 networks (this machine — an outlier)' },
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
  // Sentinel discipline (root AGENTS.md): reachable-but-broken is a third state,
  // never folded into "connected" or "absent".
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
