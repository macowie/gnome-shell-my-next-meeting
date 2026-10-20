import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {EDataServer, INSTALL_COMMAND, loadError} from './deps.js';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class MyNextMeetingPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const appearance = new Adw.PreferencesGroup({title: _('Appearance')});
        const width = new Adw.SpinRow({
            title: _('Maximum width'),
            subtitle: _('Longer titles are truncated (pixels)'),
            adjustment: new Gtk.Adjustment({lower: 50, upper: 2000, step_increment: 10}),
        });
        settings.bind('max-width', width, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearance.add(width);
        page.add(appearance);

        const position = new Adw.PreferencesGroup({title: _('Position')});
        const positionCombo = new Gtk.ComboBoxText();
        for (const label of [
            _('Left'), _('Center'), _('Right'), _('Far Left'), _('Far Right'),
        ])
            positionCombo.append_text(label);
        settings.bind('position-in-panel', positionCombo, 'active', Gio.SettingsBindFlags.DEFAULT);
        const positionRow = new Adw.ActionRow({title: _('Position in panel')});
        positionRow.set_activatable_widget(positionCombo);
        positionRow.add_suffix(positionCombo);
        position.add(positionRow);
        page.add(position);

        const meetings = new Adw.PreferencesGroup({title: _('Meetings')});
        const earlyJoin = new Adw.SpinRow({
            title: _('Early join window'),
            subtitle: _('Minutes before the start time a meeting becomes joinable'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 60, step_increment: 1}),
        });
        settings.bind('early-join-minutes', earlyJoin, 'value', Gio.SettingsBindFlags.DEFAULT);
        meetings.add(earlyJoin);
        page.add(meetings);

        const calendars = new Adw.PreferencesGroup({
            title: _('Calendars'),
            description: _('Calendars from GNOME Calendar to include'),
        });
        page.add(calendars);

        if (loadError) {
            calendars.add(new Adw.ActionRow({
                title: _('Calendar libraries are missing'),
                subtitle: `${_('Install them, then log out and back in:')}\n${INSTALL_COMMAND}`,
                subtitle_selectable: true,
            }));
            return;
        }

        const registry = EDataServer.SourceRegistry.new_sync(null);
        const sources = registry.list_sources(EDataServer.SOURCE_EXTENSION_CALENDAR)
            .filter(s => s.enabled)
            .sort((a, b) => a.display_name.localeCompare(b.display_name));

        for (const source of sources) {
            const row = new Adw.SwitchRow({
                title: source.display_name,
                subtitle: registry.ref_source(source.parent)?.display_name ?? '',
                active: !settings.get_strv('hidden-calendars').includes(source.uid),
            });
            row.connect('notify::active', () => {
                const hidden = settings.get_strv('hidden-calendars').filter(uid => uid !== source.uid);
                if (!row.active)
                    hidden.push(source.uid);
                settings.set_strv('hidden-calendars', hidden);
            });
            calendars.add(row);
        }
    }
}
