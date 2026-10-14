# My Next Meeting

GNOME Shell extension that shows your next meeting in the top bar, e.g. `in 5mins: Standup`.

- Click the label for a menu:
  - **Join meeting** opens the event's Google Meet or Zoom link.
  - The rest of today's events are listed below; clicking one opens your calendar app.
- Reads every calendar that GNOME Calendar shows, through Evolution Data Server.
- Settings let you turn off individual calendars and set a maximum label width.

Requires GNOME Shell 50.

## Dependencies

The extension needs the GObject Introspection bindings for Evolution Data Server. GNOME Shell doesn't install them. If they're missing, the top bar shows **Attention required**; click it for install instructions.

Debian / Ubuntu:

```sh
sudo apt install gir1.2-ecal-2.0 gir1.2-edataserver-1.2 gir1.2-ical-3.0
```

On other distros these bindings usually come with the `evolution-data-server` and `libical` packages.

## Install

```sh
git clone <repo> ~/.local/share/gnome-shell/extensions/my-next-meeting@cowie.me
cd ~/.local/share/gnome-shell/extensions/my-next-meeting@cowie.me
glib-compile-schemas schemas/
```

Log out and back in, then enable it:

```sh
gnome-extensions enable my-next-meeting@cowie.me
```

## Tests

```sh
gjs -m tests/util.test.js
```
