// Pure helpers, kept free of gi imports so they can be tested with plain gjs.

// 300 -> "5mins", 5400 -> "1h30m", 90000 -> "1d"
export function formatUntil(seconds) {
    const mins = Math.max(0, Math.ceil(seconds / 60));
    if (mins < 60)
        return `${mins}min${mins === 1 ? '' : 's'}`;
    const h = Math.floor(mins / 60), m = mins % 60;
    if (h < 24)
        return m ? `${h}h${m}m` : `${h}h`;
    return `${Math.floor(h / 24)}d`;
}

// Scans raw iCalendar text (location, description, X-GOOGLE-CONFERENCE, ...) for a join link.
// Prefers a Zoom link, then a Google Meet link, then the first other http(s) URL found.
export function findMeetingUrl(ics) {
    const text = ics.replace(/\r?\n[ \t]/g, ''); // unfold RFC 5545 line continuations
    const zoom = text.match(/https:\/\/[\w.-]*zoom\.us\/[^\s"'<>\\]+/i);
    if (zoom)
        return zoom[0];
    const meet = text.match(/https:\/\/meet\.google\.com\/[a-z0-9-]+/i);
    if (meet)
        return meet[0];
    const any = text.match(/https?:\/\/[^\s"'<>\\]+/i);
    return any ? any[0] : null;
}
