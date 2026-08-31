/* PROTOTYPE — issue #9. Throwaway.
 *
 * Inline SVG network marks. Inline because the prototype pulls no external
 * assets and the artifact must render offline; simplified because these are
 * read at 14–26px in a rail and as ~14px badges on a row, where silhouette and
 * colour carry recognition, not detail.
 *
 * In the real implementation the icon set follows whatever GET /v1/accounts
 * returns rather than a hardcoded map — a network PortOS has never heard of
 * must still render, which is what `Fallback` is for.
 */

const Wrap = ({ size, rounded, bg, children, title }) => (
  <span
    role="img"
    aria-label={title}
    title={title}
    className="inline-flex shrink-0 items-center justify-center overflow-hidden"
    style={{ width: size, height: size, borderRadius: rounded ? size * 0.28 : '50%', background: bg }}
  >
    {children}
  </span>
);

const svg = (children, extra = {}) => (
  <svg viewBox="0 0 24 24" width="66%" height="66%" fill="none" {...extra}>{children}</svg>
);

const MARKS = {
  whatsapp: ({ size }) => (
    <Wrap size={size} bg="#25D366" title="WhatsApp">
      {svg(
        <path
          fill="#fff"
          d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm5.1 14c-.2.6-1.2 1.2-1.7 1.2-.5 0-1 .2-3.2-.7-2.7-1.1-4.4-3.9-4.5-4.1-.1-.2-1-1.4-1-2.6s.6-1.8.9-2.1c.2-.2.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.3.5-.4.4c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.1 1 2 1.3 2.3 1.4.3.1.4.1.6-.1l.8-1c.2-.2.4-.2.6-.1l2 .9c.2.1.4.2.4.3.1.1.1.6-.1 1.2Z"
        />,
      )}
    </Wrap>
  ),
  googlemessages: ({ size }) => (
    <Wrap size={size} bg="#1A73E8" title="Google Messages">
      {svg(
        <path
          fill="#fff"
          d="M12 3C6.9 3 3 6.6 3 11c0 2.5 1.3 4.7 3.3 6.2V22l3.6-2.1c.7.1 1.4.2 2.1.2 5.1 0 9-3.6 9-8.1S17.1 3 12 3Z"
        />,
      )}
    </Wrap>
  ),
  discord: ({ size }) => (
    <Wrap size={size} rounded bg="#5865F2" title="Discord">
      {svg(
        <path
          fill="#fff"
          d="M19.3 6.4A15 15 0 0 0 15.6 5.3l-.2.4a13 13 0 0 1 3.3 1.6 12.4 12.4 0 0 0-9.4 0 13 13 0 0 1 3.3-1.6l-.3-.4a15 15 0 0 0-3.7 1.1C5.4 9.7 4.9 12.9 5.1 16a15 15 0 0 0 4.6 2.3l.9-1.4a9.7 9.7 0 0 1-1.5-.7l.4-.3a10.6 10.6 0 0 0 9.2 0l.4.3c-.5.3-1 .5-1.5.7l.9 1.4a15 15 0 0 0 4.6-2.3c.3-3.6-.5-6.8-2.8-9.6ZM9.7 14.2c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.7.8 1.6 1.8c0 1-.7 1.8-1.6 1.8Zm5.9 0c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.7.8 1.6 1.8c0 1-.7 1.8-1.6 1.8Z"
        />,
      )}
    </Wrap>
  ),
  facebook: ({ size }) => (
    <Wrap size={size} bg="#0866FF" title="Messenger">
      {svg(
        <path
          fill="#fff"
          d="M12 3c-5 0-8.8 3.6-8.8 8.4 0 2.7 1.2 5.1 3.2 6.7v3.3l3-1.6c.8.2 1.7.3 2.6.3 5 0 8.8-3.6 8.8-8.4S17 3 12 3Zm.9 11.2-2.3-2.4-4.3 2.4 4.7-5 2.4 2.4L17.6 9l-4.7 5.2Z"
        />,
      )}
    </Wrap>
  ),
  signal: ({ size }) => (
    <Wrap size={size} bg="#3A76F0" title="Signal">
      {svg(
        <path
          fill="#fff"
          d="M12 3.2c-4.9 0-8.8 3.5-8.8 7.8 0 2 .8 3.8 2.2 5.2l-.9 3.9 4.2-1.3c1 .3 2.1.5 3.3.5 4.9 0 8.8-3.5 8.8-7.8S16.9 3.2 12 3.2Z"
        />,
      )}
    </Wrap>
  ),
  instagram: ({ size }) => (
    <span
      role="img"
      aria-label="Instagram"
      title="Instagram"
      className="inline-flex shrink-0 items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        background: 'radial-gradient(circle at 30% 107%, #fdf497 0%, #fd5949 45%, #d6249f 60%, #285AEB 90%)',
      }}
    >
      {svg(
        <>
          <rect x="3.5" y="3.5" width="17" height="17" rx="5" stroke="#fff" strokeWidth="2" />
          <circle cx="12" cy="12" r="4" stroke="#fff" strokeWidth="2" />
          <circle cx="17.2" cy="6.8" r="1.2" fill="#fff" />
        </>,
      )}
    </span>
  ),
  telegram: ({ size }) => (
    <Wrap size={size} bg="#29A9EB" title="Telegram">
      {svg(<path fill="#fff" d="M21 5.2 3.6 11.4c-.9.3-.9.9-.1 1.1l4.4 1.4 1.7 5.1c.2.6.4.7.9.3l2.4-2 4.6 3.4c.8.5 1.3.2 1.5-.8l2.7-12.6c.2-1-.4-1.5-1.2-1.1ZM9.6 14l8.4-5.3c.4-.2.8 0 .4.3l-7.1 6.4-.3 3-1.4-4.4Z" />)}
    </Wrap>
  ),
  slack: ({ size }) => (
    <Wrap size={size} rounded bg="#fff" title="Slack">
      {svg(
        <>
          <path fill="#36C5F0" d="M6.8 14.3a2 2 0 1 1-2-2h2v2Zm1 0a2 2 0 0 1 4 0v5a2 2 0 1 1-4 0v-5Z" />
          <path fill="#2EB67D" d="M9.8 6.6a2 2 0 1 1 2-2v2h-2Zm0 1a2 2 0 0 1 0 4h-5a2 2 0 1 1 0-4h5Z" />
          <path fill="#ECB22E" d="M17.2 9.6a2 2 0 1 1 2 2h-2v-2Zm-1 0a2 2 0 0 1-4 0v-5a2 2 0 1 1 4 0v5Z" />
          <path fill="#E01E5A" d="M14.2 17.3a2 2 0 1 1-2 2v-2h2Zm0-1a2 2 0 0 1 0-4h5a2 2 0 1 1 0 4h-5Z" />
        </>,
      )}
    </Wrap>
  ),
  x: ({ size }) => (
    <Wrap size={size} bg="#000" title="X">
      {svg(<path fill="#fff" d="M17.5 3h2.9l-6.3 7.2L21.6 21h-5.8l-4.5-5.9L6 21H3.1l6.7-7.7L2.7 3h5.9l4.1 5.4L17.5 3Zm-1 16.2h1.6L7.6 4.7H5.9l10.6 14.5Z" />)}
    </Wrap>
  ),
};

/** Any network PortOS has no mark for still renders: initial on a neutral chip. */
const Fallback = ({ size, label }) => (
  <Wrap size={size} rounded bg="#4b5563" title={label}>
    <span style={{ fontSize: size * 0.5, color: '#fff', fontWeight: 700 }}>{(label || '?')[0].toUpperCase()}</span>
  </Wrap>
);

export default function NetworkLogo({ network, label, size = 16 }) {
  const Mark = MARKS[network];
  return Mark ? <Mark size={size} /> : <Fallback size={size} label={label || network} />;
}
