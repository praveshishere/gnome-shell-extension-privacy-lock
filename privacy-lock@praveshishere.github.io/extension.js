import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { LockShield, PinPrompt } from './lockUI.js';
import * as PinStore from './pinStore.js';

const FAIL_THRESHOLD = 5;

// org.gnome.SessionManager.Inhibit flag 4 = suspending, 8 = marking the
// session idle. Idle is what drives GNOME's own blank-and-lock, so holding
// both stops the real lock screen from appearing on top of ours.
const INHIBIT_SUSPEND = 4;
const INHIBIT_IDLE = 8;

// How far ahead of the session's own idle threshold we arm our idle watch.
// See _armIdleWatch for why this margin has to exist at all.
const IDLE_MARGIN_MS = 30 * 1000;
const BACKOFF_DELAYS_SEC = [1, 2, 5, 30];

const DBUS_IFACE = `
<node>
  <interface name="org.gnome.Shell.Extensions.PrivacyLock">
    <method name="Lock"/>
  </interface>
</node>`;

export default class PrivacyLockExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._locked = false;
        this._overlayGroup = null;
        this._shield = null;
        this._pinPrompt = null;
        this._pinSubmitId = 0;
        this._grab = null;
        this._failCount = 0;
        this._lockoutTimeoutId = 0;
        this._idleWatchId = 0;
        this._inhibitCookie = 0;
        this._inhibitPending = false;
        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._sessionSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.session',
        });

        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(DBUS_IFACE, this);
        this._dbusImpl.export(Gio.DBus.session, '/org/gnome/shell/extensions/PrivacyLock');

        Main.wm.addKeybinding(
            'lock-keybinding', this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._lock());

        this._settingsChangedId = this._settings.connect('changed::inactivity-minutes',
            () => this._armIdleWatch());
        // Our threshold is derived from the session's, so re-arm if that moves.
        this._sessionIdleChangedId = this._sessionSettings.connect(
            'changed::idle-delay', () => this._armIdleWatch());

        this._armIdleWatch();
    }

    disable() {
        if (this._locked)
            this._unlock();

        Main.wm.removeKeybinding('lock-keybinding');

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if (this._sessionIdleChangedId) {
            this._sessionSettings.disconnect(this._sessionIdleChangedId);
            this._sessionIdleChangedId = 0;
        }

        this._disarmIdleWatch();

        if (this._dbusImpl) {
            this._dbusImpl.unexport();
            this._dbusImpl = null;
        }

        this._settings = null;
        this._sessionSettings = null;
        this._idleMonitor = null;
    }

    // D-Bus method: org.gnome.Shell.Extensions.PrivacyLock.Lock
    Lock() {
        this._lock();
    }

    /**
     * Stop GNOME's own screen shield from blanking and locking on top of our
     * overlay. Without this, our lock and the session's idle timer run
     * independently, so the real lock screen appears over ours after a few
     * minutes and the user has to clear two locks.
     *
     * Note this covers the *idle* path only. An explicit Super+L is already
     * blocked while locked, because our modal grab runs with
     * Shell.ActionMode.NONE and the media-keys shortcut needs NORMAL. A lid
     * close or a manual suspend still locks on resume — that is the session's
     * call, not something an extension can veto.
     */
    _inhibitIdle() {
        if (this._inhibitCookie || this._inhibitPending)
            return;

        this._inhibitPending = true;
        Gio.DBus.session.call(
            'org.gnome.SessionManager',
            '/org/gnome/SessionManager',
            'org.gnome.SessionManager',
            'Inhibit',
            new GLib.Variant('(susu)', [
                this.uuid,
                0, // no toplevel xid to associate with
                'Privacy lock overlay is active',
                INHIBIT_SUSPEND | INHIBIT_IDLE,
            ]),
            new GLib.VariantType('(u)'),
            Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                this._inhibitPending = false;
                let cookie = 0;
                try {
                    [cookie] = conn.call_finish(res).deepUnpack();
                } catch (e) {
                    logError(e, 'privacy-lock: could not inhibit idle');
                    return;
                }
                // The reply is async, so we may already have been unlocked
                // by the time it lands. Drop the inhibit immediately if so,
                // otherwise it would leak for the rest of the session.
                if (!this._locked) {
                    this._releaseCookie(cookie);
                    return;
                }
                this._inhibitCookie = cookie;
            });
    }

    _uninhibitIdle() {
        if (this._inhibitCookie) {
            this._releaseCookie(this._inhibitCookie);
            this._inhibitCookie = 0;
        }
    }

    _releaseCookie(cookie) {
        Gio.DBus.session.call(
            'org.gnome.SessionManager',
            '/org/gnome/SessionManager',
            'org.gnome.SessionManager',
            'Uninhibit',
            new GLib.Variant('(u)', [cookie]),
            null, Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    logError(e, 'privacy-lock: could not release idle inhibit');
                }
            });
    }

    _armIdleWatch() {
        this._disarmIdleWatch();
        const minutes = this._settings.get_int('inactivity-minutes');
        if (minutes <= 0)
            return;

        let delayMs = minutes * 60 * 1000;

        // GNOME's own blank-and-lock runs off this same idle monitor. If we
        // armed at or after the session's idle-delay, both would fire at the
        // same instant — and the idle inhibit we take when locking would
        // arrive just as the session went idle, too late to stop the real
        // lock screen appearing over ours. An inhibit prevents the session
        // becoming idle; it does not undo it. So always fire a margin ahead
        // of the session, whatever the user picked.
        const sessionIdleMs = this._sessionSettings.get_uint('idle-delay') * 1000;
        if (sessionIdleMs > 0) {
            const latest = sessionIdleMs - IDLE_MARGIN_MS;
            // A session idle-delay below the margin leaves no room to get
            // ahead of it; fall back to the user's value rather than a
            // nonsensical zero or negative delay.
            if (latest > 0 && delayMs > latest)
                delayMs = latest;
        }

        this._idleWatchId = this._idleMonitor.add_idle_watch(
            delayMs,
            () => {
                this._idleWatchId = 0;
                this._lock();
            });
    }

    _disarmIdleWatch() {
        if (this._idleWatchId) {
            this._idleMonitor.remove_watch(this._idleWatchId);
            this._idleWatchId = 0;
        }
    }

    _lock() {
        if (this._locked)
            return;

        if (!PinStore.hasPin()) {
            Main.notifyError(
                'Privacy Lock',
                'Set a PIN in the extension preferences before locking.');
            return;
        }

        this._locked = true;
        this._failCount = 0;

        // The overlay is transparent, so the live desktop below simply
        // stays visible — there is nothing to capture or mirror.
        this._buildOverlay();

        this._grab = Main.pushModal(this._overlayGroup,
            { actionMode: Shell.ActionMode.NONE });
        if (!this._grab) {
            // Without a grab the overlay would swallow the screen while
            // refusing input, so tear it down instead of trapping the session.
            logError(new Error('privacy-lock: could not grab input; not locking'));
            this._unlock();
            return;
        }

        this._inhibitIdle();
        this._pinPrompt.focus();
    }

    _buildOverlay() {
        // Plain container; the shield child is what actually covers the
        // screen and catches pointer events.
        this._overlayGroup = new Clutter.Actor({ reactive: true });
        Main.layoutManager.uiGroup.add_child(this._overlayGroup);

        this._shield = new LockShield(
            this._settings.get_string('tint-color'),
            this._settings.get_double('tint-opacity'));
        this._overlayGroup.add_child(this._shield);

        this._pinPrompt = new PinPrompt();
        const primary = Main.layoutManager.primaryMonitor;
        this._overlayGroup.add_child(this._pinPrompt);
        // Center after the actor has computed its natural size.
        const [, natWidth] = this._pinPrompt.get_preferred_width(-1);
        const [, natHeight] = this._pinPrompt.get_preferred_height(-1);
        this._pinPrompt.set_position(
            primary.x + Math.floor((primary.width - natWidth) / 2),
            primary.y + Math.floor((primary.height - natHeight) / 2));

        this._pinSubmitId = this._pinPrompt.connect(
            'submit', (_actor, pin) => this._onPinSubmit(pin));
    }

    _unlock() {
        if (!this._locked)
            return;

        this._locked = false;
        this._uninhibitIdle();

        if (this._lockoutTimeoutId) {
            GLib.source_remove(this._lockoutTimeoutId);
            this._lockoutTimeoutId = 0;
        }
        if (this._pinPrompt && this._pinSubmitId) {
            this._pinPrompt.disconnect(this._pinSubmitId);
            this._pinSubmitId = 0;
        }

        // popModal must receive the Clutter.Grab that pushModal returned, not
        // the actor. Destroy the overlay even if releasing the grab fails,
        // otherwise a throw here leaves the screen covered and input trapped.
        try {
            if (this._grab) {
                Main.popModal(this._grab);
                this._grab = null;
            }
        } catch (e) {
            logError(e, 'privacy-lock: releasing modal grab failed');
        } finally {
            if (this._overlayGroup) {
                this._overlayGroup.destroy();
                this._overlayGroup = null;
            }
        }
        this._shield = null;
        this._pinPrompt = null;
        this._failCount = 0;

        this._armIdleWatch();
    }

    _onPinSubmit(pin) {
        if (PinStore.verify(pin)) {
            this._unlock();
            return;
        }

        this._failCount++;
        this._pinPrompt.clear();
        this._pinPrompt.shake();

        if (this._failCount >= FAIL_THRESHOLD) {
            const overIdx = this._failCount - FAIL_THRESHOLD;
            const delaySec = BACKOFF_DELAYS_SEC[
                Math.min(overIdx, BACKOFF_DELAYS_SEC.length - 1)];

            this._pinPrompt.setLocked(true);
            this._pinPrompt.showError(`Too many attempts. Try again in ${delaySec}s.`);

            this._lockoutTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, delaySec * 1000,
                () => {
                    this._lockoutTimeoutId = 0;
                    if (!this._pinPrompt)
                        return GLib.SOURCE_REMOVE;
                    this._pinPrompt.setLocked(false);
                    this._pinPrompt.clearError();
                    this._pinPrompt.focus();
                    return GLib.SOURCE_REMOVE;
                });
        } else {
            this._pinPrompt.showError('Incorrect PIN');
        }
    }
}
