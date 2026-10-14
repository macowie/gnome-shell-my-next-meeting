// Run: gjs -m tests/util.test.js
import {formatUntil, findMeetingUrl} from '../util.js';

const eq = (a, b) => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

eq(formatUntil(0), '0mins');
eq(formatUntil(30), '1min');
eq(formatUntil(300), '5mins');
eq(formatUntil(3600), '1h');
eq(formatUntil(5400), '1h30m');
eq(formatUntil(90000), '1d');

eq(findMeetingUrl('LOCATION:https://lol.zoom.us/j/8675309?pwd=foor\n'), 'https://lol.zoom.us/j/8675309?pwd=foor');
eq(findMeetingUrl('DESCRIPTION:Join: https://meet.google.com/abc-de\r\n fgh-ijk\\nmore'), 'https://meet.google.com/abc-defgh-ijk');
eq(findMeetingUrl('DESCRIPTION:<a href="https://zoom.us/j/1">x</a>'), 'https://zoom.us/j/1');
eq(findMeetingUrl('LOCATION:Room 4\\, https://example.com'), 'https://example.com');

// preference order: zoom > meet > first other url, regardless of position
eq(findMeetingUrl('DESCRIPTION:https://meet.google.com/abc-de and https://acme.zoom.us/j/9\n'), 'https://acme.zoom.us/j/9');
eq(findMeetingUrl('DESCRIPTION:see https://example.com and https://meet.google.com/xyz\n'), 'https://meet.google.com/xyz');
eq(findMeetingUrl('DESCRIPTION:https://example.com / https://z.zoom.us/j/5\n'), 'https://z.zoom.us/j/5');

// fallback: first uncategorized url (http too), and null when there is none
eq(findMeetingUrl('DESCRIPTION:http://meet.example.org/x'), 'http://meet.example.org/x');
eq(findMeetingUrl('DESCRIPTION:meet.example.org is not a link'), null);
eq(findMeetingUrl('LOCATION:Room 4'), null);
print('ok');
