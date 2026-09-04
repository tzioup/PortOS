import { describe, it, expect } from 'vitest';
import { decodeHtmlEntities } from './BeeperThread';

/**
 * #35 real-browser pass: a message body containing an ampersand rendered as
 * the five-character HTML entity `&amp;` in the thread bubble. Beeper Desktop
 * delivers entity-encoded text for some bridged networks; PortOS itself never
 * escapes on the way in (`beeperSync.js` `normalizeMessageRow` passes
 * `message.text` through unchanged), so decoding belongs here, on the way out
 * to the DOM — as a plain text node, never `dangerouslySetInnerHTML`.
 */
describe('decodeHtmlEntities', () => {
  it('decodes the five predefined named entities', () => {
    expect(decodeHtmlEntities('&amp;')).toBe('&');
    expect(decodeHtmlEntities('&lt;')).toBe('<');
    expect(decodeHtmlEntities('&gt;')).toBe('>');
    expect(decodeHtmlEntities('&quot;')).toBe('"');
    expect(decodeHtmlEntities('&#39;')).toBe("'");
  });

  it('decodes a realistic sentence with an ampersand', () => {
    expect(decodeHtmlEntities('salt &amp; pepper')).toBe('salt & pepper');
  });

  it('leaves a plain string with no entities untouched', () => {
    expect(decodeHtmlEntities('no entities here')).toBe('no entities here');
  });

  it('is double-decode-safe: &amp;lt; decodes to &lt;, never <', () => {
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
  });

  it('leaves an unknown named entity and an out-of-range numeric ref untouched', () => {
    expect(decodeHtmlEntities('&zzz;')).toBe('&zzz;');
    expect(decodeHtmlEntities('&#99999999;')).toBe('&#99999999;');
  });

  it('passes through non-string and empty input unchanged', () => {
    expect(decodeHtmlEntities(undefined)).toBe(undefined);
    expect(decodeHtmlEntities(null)).toBe(null);
    expect(decodeHtmlEntities('')).toBe('');
  });
});
