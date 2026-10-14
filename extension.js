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

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, _('My Next Meeting'));
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
            this._registryIds = ['source-added', 'source-removed', 'source-changed']
                .map(sig => this._registry.connect(sig, () => this._fetch()));
            this._fetch();
        });
        this._settingsIds = [
            settings.connect('changed::hidden-calendars', () => this._fetch()),
            settings.connect('changed::max-width', () => this._applyWidth()),
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

    async _fetch(rebuildOpenMenu = false) {
        if (!this._registry || this._gen === -1)
            return;
        const gen = this._gen = (this._gen ?? 0) + 1;
        const hidden = this._settings.get_strv('hidden-calendars');
        const sources = this._registry.list_sources(EDataServer.SOURCE_EXTENSION_CALENDAR)
            .filter(s => s.enabled && !hidden.includes(s.uid));

        const now = Math.floor(Date.now() / 1000);
        const until = now + LOOKAHEAD_DAYS * 86400;
        const sexp = `(occur-in-time-range? (make-time "${ECal.isodate_from_time_t(now)}") (make-time "${ECal.isodate_from_time_t(until)}"))`;

        const perSource = await Promise.all(sources.map(async source => {
            try {
                let client = this._clients.get(source.uid);
                if (!client) {
                    client = await connectClient(source);
                    this._clients.set(source.uid, client);
                }
                const events = [];
                for (const obj of withoutDetachedDuplicates(await getObjectList(client, sexp))) {
                    client.generate_instances_for_object_sync(obj, now, until, null, (ic, start, end) => {
                        if (!start.is_date() && ic.get_status() !== ICalGLib.PropertyStatus.CANCELLED) {
                            events.push({
                                title: ic.get_summary() || _('(No title)'),
                                start: toUnix(start),
                                end: toUnix(end),
                                url: findMeetingUrl(ic.as_ical_string()),
                            });
                        }
                        return true;
                    });
                }
                return events;
            } catch (e) {
                console.warn(`my-next-meeting: ${source.display_name}: ${e.message}`);
                this._clients.delete(source.uid);
                return [];
            }
        }));

        if (gen !== this._gen) // a newer fetch started (or we were destroyed) meanwhile
            return;
        this._events = perSource.flat().sort((a, b) => a.start - b.start);
        this._render(rebuildOpenMenu);
    }

    _render(rebuildOpenMenu = false) {
        const now = Date.now() / 1000;
        const upcoming = this._events.filter(e => e.end > now);
        const next = upcoming[0];

        this._label.text = !next ? _('No meetings')
            : next.start <= now ? `${_('now')}: ${next.title}`
            : `${_('in')} ${formatUntil(next.start - now)}: ${next.title}`;

        // Don't rebuild under the user's pointer, except right after an open-triggered fetch.
        if (this.menu.isOpen && !rebuildOpenMenu)
            return;
        this.menu.removeAll();
        if (!next)
            return;

        const join = new PopupMenu.PopupMenuItem(_('Join meeting'));
        join.setSensitive(!!next.url);
        join.connect('activate', () => Gio.AppInfo.launch_default_for_uri(next.url, null));
        this.menu.addMenuItem(join);

        const endOfDay = new Date();
        endOfDay.setHours(24, 0, 0, 0);
        const rest = upcoming.slice(1).filter(e => e.start < endOfDay / 1000);
        if (rest.length)
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        for (const e of rest) {
            const time = GLib.DateTime.new_from_unix_local(e.start).format('%R');
            const item = new PopupMenu.PopupMenuItem(`${time}  ${e.title}`);
            item.connect('activate', () => Gio.AppInfo.get_default_for_type('text/calendar', false)
                ?.launch([], global.create_app_launch_context(0, -1)));
            this.menu.addMenuItem(item);
        }
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
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
