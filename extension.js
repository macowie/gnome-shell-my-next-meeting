/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {formatUntil, findMeetingUrl} from './util.js';
import {ECal, EDataServer, ICalGLib, INSTALL_COMMAND, loadError} from './deps.js';

const LOOKAHEAD_DAYS = 7;
const TICK_SECONDS = 30;
// shortcut: polls EDS every 5 min instead of watching ECal.ClientView, upgrade if edits must show instantly.
const FETCH_EVERY_TICKS = 10;

const connectClient = source => new Promise((resolve, reject) => {
    ECal.Client.connect(source, ECal.ClientSourceType.EVENTS, 30, null, (_o, res) => {
        try {
            resolve(ECal.Client.connect_finish(res));
        } catch (e) {
            reject(e);
        }
    });
});

const getObjectList = (client, sexp) => new Promise((resolve, reject) => {
    client.get_object_list(sexp, null, (_c, res) => {
        try {
            resolve(client.get_object_list_finish(res)[1]);
        } catch (e) {
            reject(e);
        }
    });
});

// Detached recurrence exceptions are already expanded via their master; keep only orphans.
const withoutDetachedDuplicates = objs => {
    const isDetached = o => !o.get_recurrenceid().is_null_time();
    const masters = new Set(objs.filter(o => !isDetached(o)).map(o => o.get_uid()));
    return objs.filter(o => !(isDetached(o) && masters.has(o.get_uid())));
};

const toUnix = t => t.as_timet_with_zone(t.get_timezone() ?? ICalGLib.Timezone.get_utc_timezone());

const hasRRule = obj => !!obj.get_first_property(ICalGLib.PropertyKind.RRULE_PROPERTY);

// ICal.Component.get_status() throws for events without a STATUS property: libical
// returns 0, which is not a member of the PropertyStatus enum, so GJS refuses to
// convert it ("0 is not a valid value for enumeration PropertyStatus"). Read the
// property as text instead; a missing STATUS means the event is not cancelled.
const statusOf = ic => {
    const prop = ic.get_first_property(ICalGLib.PropertyKind.STATUS_PROPERTY);
    return prop ? (prop.get_value_as_string() ?? '') : '';
};

// expandInstances runs the C recurrence expansion for one component.
//
// generate_instances_for_object_sync() returns void, so it has no error channel of
// its own: any failure inside the callback (including a JS exception) is swallowed by
// GJS and simply aborts the expansion, which looks like "no instances found".
// So: catch inside the callback, count invocations and fall back to the raw DTSTART
// for non-recurring events.
const expandInstances = (client, obj, now, until) => {
    const instances = [];
    let callbackError = null;
    try {
        client.generate_instances_for_object_sync(obj, now, until, null, (ic, start, end) => {
            try {
                instances.push({ic, start, end});
            } catch (e) {
                callbackError = e;
                console.warn(`my-next-meeting: expansion callback failed: ${e.message}`);
            }
            return true;
        });
    } catch (e) {
        console.warn(`my-next-meeting: expansion threw for ${obj.get_uid()}: ${e.message}`);
        return [];
    }

    if (instances.length)
        return instances;

    if (callbackError)
        return [];

    // No instances: either the event is out of range (recurring master whose
    // occurrences are elsewhere) or expansion silently produced nothing.
    if (hasRRule(obj))
        return [];

    // Non-recurring event: trust DTSTART/DTEND directly.
    const start = obj.get_dtstart();
    if (!start || start.is_null_time())
        return [];
    const dtend = obj.get_dtend();
    const end = dtend && !dtend.is_null_time()
        ? dtend
        : start.add(ICalGLib.Duration.from_int(3600));
    return [{ic: obj, start, end}];
};

function eventLabel(calEvent, now) {
    return calEvent.start <= now ? `${_('now')}: ${calEvent.title}`
    : `${_('in')} ${formatUntil(calEvent.start - now)}: ${calEvent.title}`;
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.5, _('My Next Meeting')); // 0.5 = menu centered on the indicator
        this._settings = settings;
        this._clients = new Map(); // source uid -> ECal.Client
        this._events = [];
        this._ticks = 0;

        this._label = new St.Label({text: '…', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._label);

        this._registryIds = [];
        EDataServer.SourceRegistry.new(null, (_o, res) => {
            try {
                this._registry = EDataServer.SourceRegistry.new_finish(res);
            } catch (e) {
                this._label.text = _('Calendar unavailable');
                console.error(`my-next-meeting: ${e.message}`);
                return;
            }
            if (this._gen === -1) // destroyed before the registry arrived
                return;
            console.log('my-next-meeting: source registry ready');
            this._registryIds = ['source-added', 'source-removed', 'source-changed']
                .map(sig => this._registry.connect(sig, () => this._fetch()));
            this._fetch();
        });
        this._settingsIds = [
            settings.connect('changed::hidden-calendars', () => this._fetch()),
            settings.connect('changed::max-width', () => this._applyWidth()),
            settings.connect('changed::position-in-panel', () => this._applyPosition()),
            settings.connect('changed::early-join-minutes', () => this._render()),
        ];
        this._applyWidth();

        // Menu is owned by this actor, so the handler dies with it on destroy.
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._fetch(true);
        });

        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            if (++this._ticks % FETCH_EVERY_TICKS === 0)
                this._fetch();
            else
                this._render();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _applyWidth() {
        this._label.style = `max-width: ${this._settings.get_int('max-width')}px;`;
    }

    // Mirrors Vitals' panel positions. Returns [alignment, position] and sets the
    // menu arrow so the dropdown is always centered on the indicator, whichever
    // box of the top bar it sits in.
    _positionInPanel() {
        let alignment, position;
        switch (this._settings.get_int('position-in-panel')) {
        case 0: // left
            alignment = 'left'; position = -1; break;
        case 1: // center
            alignment = 'center'; position = -1; break;
        case 2: // right
            alignment = 'right'; position = 0; break;
        case 3: // far left
            alignment = 'left'; position = 0; break;
        case 4: // far right (default: the historical right-most spot)
        default:
            alignment = 'right'; position = -1; break;
        }
        // 0.5 puts the arrow in the middle of the menu, so the menu is centered
        // on the indicator instead of hanging off to one side of it.
        this.menu._arrowAlignment = 0.5;
        return [alignment, position];
    }

    // Re-parent the button into the selected box when the preference changes.
    _applyPosition() {
        const parent = this.get_parent();
        if (parent)
            parent.remove_child(this);
        const [alignment, position] = this._positionInPanel();
        const box = {
            left: Main.panel._leftBox,
            center: Main.panel._centerBox,
            right: Main.panel._rightBox,
        }[alignment];
        if (position >= 0 && position < box.get_n_children())
            box.insert_child_at_index(this, position);
        else
            box.add_child(this);
    }

    async _fetch(rebuildOpenMenu = false) {
        try {
            if (!this._registry || this._gen === -1)
                return;
            const gen = this._gen = (this._gen ?? 0) + 1;
            const hidden = this._settings.get_strv('hidden-calendars');
            const sources = this._registry.list_sources(EDataServer.SOURCE_EXTENSION_CALENDAR)
                .filter(s => s.enabled && !hidden.includes(s.uid));

            const now = Math.floor(Date.now() / 1000);
            const until = now + LOOKAHEAD_DAYS * 86400;
            const sexp = `(occur-in-time-range? (make-time "${ECal.isodate_from_time_t(now)}") (make-time "${ECal.isodate_from_time_t(until)}"))`;
            console.log(`my-next-meeting: fetch started: ${sources.length} source(s) [${sources.map(s => s.display_name).join(', ') || 'none'}], window ${ECal.isodate_from_time_t(now)} .. ${ECal.isodate_from_time_t(until)}`);

            const perSource = await Promise.all(sources.map(async source => {
                try {
                    let client = this._clients.get(source.uid);
                    if (!client) {
                        client = await connectClient(source);
                        this._clients.set(source.uid, client);
                        console.log(`my-next-meeting: ${source.display_name}: connected new client`);
                    }
                    const objs = withoutDetachedDuplicates(await getObjectList(client, sexp));
                    console.log(`my-next-meeting: ${source.display_name}: ${objs.length} object(s) in range`);
                    const events = [];
                    for (const obj of objs) {
                        const instances = expandInstances(client, obj, now, until);
                        if (!instances.length) {
                            const dtstart = obj.get_dtstart();
                            console.log(`my-next-meeting: ${source.display_name}: no instance for ${obj.get_uid()} (dtstart ${dtstart?.as_ical_string() ?? 'none'}, recurring ${hasRRule(obj)})`);
                            continue;
                        }
                        for (const {ic, start, end} of instances) {
                            if (!start || start.is_date())
                                continue; // all-day events are not meetings
                            if (statusOf(ic).toUpperCase() === 'CANCELLED')
                                continue;
                            events.push({
                                title: ic.get_summary() || _('(No title)'),
                                start: toUnix(start),
                                end: toUnix(end ?? start),
                                url: findMeetingUrl(ic.as_ical_string()),
                            });
                        }
                    }
                    console.log(`my-next-meeting: ${source.display_name}: ${events.length} event(s) after expansion`);
                    return events;
                } catch (e) {
                    console.warn(`my-next-meeting: ${source.display_name}: ${e.message}`);
                    this._clients.delete(source.uid);
                    return [];
                }
            }));

            if (gen !== this._gen) // a newer fetch started (or we were destroyed) meanwhile
                return;
            const events = perSource.flat().sort((a, b) => a.start - b.start);
            console.log(`my-next-meeting: fetch finished: ${events.length} event(s) total`);
            this._events = events;
            this._render(rebuildOpenMenu);
        } catch (e) {
            console.warn(`my-next-meeting: fetch failed: ${e.message}`);
        }
    }

    _render(rebuildOpenMenu = false) {
        const now = Date.now() / 1000;
        const threshold = now + this._settings.get_int('early-join-minutes') * 60; // Shift cutoff so meetings can be joined early
        const endOfDay = new Date();
        endOfDay.setHours(24, 0, 0, 0);

        const currentAndUpcoming = this._events.filter(e => e.end > threshold);
        const next = currentAndUpcoming[0]; // Always grab the next event for the top entry, even if it's not today
        const ongoing = currentAndUpcoming.slice(1).filter(e => e.start <= threshold) // Also grab any other ongoing event as joinable
        const upcomingToday = currentAndUpcoming.slice(1).filter(e => e.start > threshold).filter(e => e.start < endOfDay / 1000); // Rest of the events today

        this._label.text = !next ? _('No meetings')
            : eventLabel(next, now);

        // Don't rebuild under the user's pointer, except right after an open-triggered fetch.
        if (this.menu.isOpen && !rebuildOpenMenu)
            return;
        this.menu.removeAll();
        if (!next)
            return;

        this.addJoinMeetingEntry(next, "Join meeting")
        for (const calEvent of ongoing) {
            this.addJoinMeetingEntry(calEvent, eventLabel(calEvent, now));
        }

        if (upcomingToday.length)
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        for (const calEvent of upcomingToday) {
            this.addFutureTodayEntry(calEvent);
        }
    }

    addJoinMeetingEntry(calEvent, label) {
        const item = new PopupMenu.PopupMenuItem(_(label));
        item.setSensitive(!!calEvent.url);
        item.connect('activate', () => Gio.AppInfo.launch_default_for_uri(calEvent.url, null));
        this.menu.addMenuItem(item);
    }

    addFutureTodayEntry(calEvent) {
        const time = GLib.DateTime.new_from_unix_local(calEvent.start).format('%R');
        const item = new PopupMenu.PopupMenuItem(`${time}  ${calEvent.title}`);
        item.connect('activate', () => Gio.AppInfo.get_default_for_type('text/calendar', false)
            ?.launch([], global.create_app_launch_context(0, -1)));
        this.menu.addMenuItem(item);
    }


    destroy() {
        this._gen = -1; // drop any in-flight fetch / registry callback
        GLib.source_remove(this._timer);
        this._registryIds.forEach(id => this._registry.disconnect(id));
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._clients.clear();
        super.destroy();
    }
});

const HelpIndicator = GObject.registerClass(
class HelpIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, _('My Next Meeting'));
        this.add_child(new St.Label({text: _('Attention required'), y_align: Clutter.ActorAlign.CENTER}));

        const info = new PopupMenu.PopupMenuItem(
            _('My Next Meeting needs the Evolution Data Server calendar libraries.\nInstall them, then log out and back in:'),
            {reactive: false});
        info.label.clutter_text.line_wrap = true;
        this.menu.addMenuItem(info);
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem(INSTALL_COMMAND, {reactive: false}));
        this.menu.addAction(_('Copy install command'), () =>
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, INSTALL_COMMAND));
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem(`${_('Error')}: ${loadError.message}`, {reactive: false}));
    }
});

export default class MyNextMeetingExtension extends Extension {
    enable() {
        this._indicator = loadError ? new HelpIndicator() : new Indicator(this.getSettings());
        if (loadError) {
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        } else {
            const [alignment, position] = this._indicator._positionInPanel();
            Main.panel.addToStatusArea(this.uuid, this._indicator, position, alignment);
        }
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
