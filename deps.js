// Calendar bindings aren't installed with GNOME Shell; load them optionally so we can show help instead of failing.
export const INSTALL_COMMAND = 'sudo apt install gir1.2-ecal-2.0 gir1.2-edataserver-1.2 gir1.2-ical-3.0';

export let ECal, EDataServer, ICalGLib;
export let loadError = null;
try {
    [{default: ECal}, {default: EDataServer}, {default: ICalGLib}] = await Promise.all([
        import('gi://ECal?version=2.0'),
        import('gi://EDataServer?version=1.2'),
        import('gi://ICalGLib?version=3.0'),
    ]);
} catch (e) {
    loadError = e;
    console.warn(`my-next-meeting: calendar libraries unavailable: ${e.message}`);
}
