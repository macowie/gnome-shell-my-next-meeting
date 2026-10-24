# My Next Meeting

GNOME Shell extension that shows your next meeting in the top bar, e.g. `in 5mins: Standup`.

- Click the label for a menu:
  - **Join meeting** opens the event's link, Zoom, Google Meet, or the first other link found.
  - The rest of today's events are listed below; clicking one opens your calendar app.
- Reads every calendar that GNOME Calendar shows, through Evolution Data Server.
- Settings let you
  - turn off individual calendars
  - set a maximum label width
  - choose where in the top bar the indicator sits (left, center, right, far left, far right)
  - set how many minutes before the start a meeting becomes joinable (for overlapping events, your Next meeting is always joinable)

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

## Acknowledgements

* [Next Meeting](https://apps.apple.com/us/app/next-meeting/id1017470484?mt=12) for Mac, whose gap I needed to fill after switching to Linux.
* The excellent [Vitals](https://github.com/corecoding/Vitals) extension for being a solid example with topbar positioning.
* A locally hosted Qwen was used to help with the EDS details to fetch events, and with defensively loading the right dependencies.