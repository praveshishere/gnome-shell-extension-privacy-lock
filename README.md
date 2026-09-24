# Privacy Lock Screen

A GNOME Shell extension that puts a lightly tinted input lock over your
screen, unlocked with a short PIN. The desktop stays visible and live
underneath — the tint is there to make the lock evident at a glance, not
to conceal anything. This blocks fumbling at the keyboard; it does not
hide your screen from anyone looking at it.

## Read this first: what this is *not*

**This is a privacy overlay, not OS-grade authentication.**

GNOME Shell is the Wayland compositor, and this extension only has power
because it runs *inside* GNOME Shell. Anything that can escape or bypass
GNOME Shell bypasses this lock completely:

- Switching to another TTY (`Ctrl+Alt+F3`), logging in, and running
  `gnome-extensions disable privacy-lock@praveshishere.github.io`.
- An SSH session into this machine doing the same.
- Killing/restarting `gnome-shell`.

No GNOME Shell extension can prevent any of this — it's a kernel/compositor
boundary, not a bug in this tool. **Keep GNOME's real lock screen (`Super+L`,
PAM-backed) as your actual security boundary.** Use this extension only as a
quick "looks busy, blocks fumbling" cover for short desk-away moments.

It is also Wayland/GNOME-Shell-46-specific. It will not work under KDE,
Sway, or other compositors, and has not been tested under an X11 GNOME
session.

## Install

### From a release

Download `privacy-lock@praveshishere.github.io.shell-extension.zip`
from the [releases page](https://github.com/praveshishere/gnome-shell-extension-privacy-lock/releases),
then:

```bash
gnome-extensions install --force privacy-lock@praveshishere.github.io.shell-extension.zip
```

**Log out and back in**, then enable it:

```bash
gnome-extensions enable privacy-lock@praveshishere.github.io
```

The logout is not optional. GNOME Shell loads an extension's JavaScript once
per shell process, and on Wayland the shell cannot be restarted in place
(there is no "Alt+F2 → r"), so a freshly installed or updated extension is
not in memory until the next login.

### From source

```bash
git clone https://github.com/praveshishere/gnome-shell-extension-privacy-lock.git
cd gnome-shell-extension-privacy-lock
make install     # packs the zip and installs it
```

Then log out, log back in, and `make enable`. Other targets: `make pack`
(build the zip only), `make lint` (syntax-check the sources), `make disable`,
`make uninstall`.

**Enabling this makes it load automatically on every future login**, the
same as any other GNOME Shell extension — there's no separate autostart
entry to manage. From the moment `enable` succeeds, the keyboard shortcut
and idle watch are live every session until you explicitly disable it.

## Hacking on it

The module-caching rule above applies to every edit, not just installs. This
is *not* enough after changing a `.js` file:

```bash
gnome-extensions disable privacy-lock@praveshishere.github.io
gnome-extensions enable privacy-lock@praveshishere.github.io
```

That re-runs `enable()` on the module GNOME Shell already has in memory, so
the shell keeps executing the old code and the extension still reports
ACTIVE with no errors — it looks like it worked. Use it only to re-apply
`enable()`/`disable()` logic or to recover a stray modal grab. Schema
changes *do* take effect without a logout, once `glib-compile-schemas` has
run, which is why the tint colour and strength are settings rather than
constants.

To check whether the running shell predates your edit:

```bash
ps -o lstart= -C gnome-shell       # when the shell last started
stat -c '%y' ~/.local/share/gnome-shell/extensions/privacy-lock@praveshishere.github.io/lockUI.js
```

If the file is newer than the process, you are looking at stale code.

Watch for errors with:

```bash
journalctl --user -f -o cat /usr/bin/gnome-shell
```

## First-time setup

1. Open **Extensions** app (or `gnome-extensions-app`) → Privacy Lock Screen
   → settings (gear icon).
2. Set a PIN under **PIN → Set…**. Locking is disabled (with a notification
   telling you so) until a PIN is set.
3. Optionally adjust the settings below.

| Setting | Key | Default | Notes |
| --- | --- | --- | --- |
| Lock after inactivity | `inactivity-minutes` | 5 | 0 disables auto-lock. Always pulled at least 30s ahead of the session's own `idle-delay`; see limitations. |
| Tint strength | `tint-opacity` | 0.15 | 0 makes the overlay invisible. |
| Tint colour | `tint-color` | `#ededed` | Neutral grey reads as a film over the desktop; saturated colours read as a colour cast. |
| Lock shortcut | `lock-keybinding` | `Super+Shift+L` | |

Appearance settings are read when the lock engages, so they can be retuned
without logging out.

## Triggering the lock

- **Keyboard shortcut** — default `Super+Shift+L`, rebindable in
  preferences. You can also point a custom shortcut in
  *Settings → Keyboard → Keyboard Shortcuts → Custom Shortcuts* at the
  D-Bus command below instead.
- **D-Bus / terminal**, independent of window focus:
  ```bash
  gdbus call --session --dest org.gnome.Shell \
    --object-path /org/gnome/shell/extensions/PrivacyLock \
    --method org.gnome.Shell.Extensions.PrivacyLock.Lock
  ```
- **Auto-lock on inactivity**, per the idle-minutes setting.

There is no tray icon — stock GNOME ships no systray, and adding one would
mean depending on a second extension (AppIndicator/KStatusNotifierItem) just
for this. The hotkey and D-Bus command cover manual triggering.

## Unlocking

Type the PIN and press Enter. Five wrong attempts in a row trigger an
increasing lockout delay (1s, 2s, 5s, then 30s) on the input field — this is
a UX deterrent against fumbling, not brute-force-resistant security (see the
caveat above).

The PIN is stored in `~/.config/privacy-lock/pin.hash` (mode 0600) as a
salted SHA-256 stretched over 50,000 rounds, with the round count recorded
in the file so it can be raised later. Stretching does not make a short PIN
strong — nothing can — it only removes the trivial offline attack against
anyone who can read the file. Verification is a fixed-time comparison.
Records written by earlier versions (a single salted round) still
verify and are rewritten in the current format on the next successful
unlock.

## Uninstall

```bash
gnome-extensions disable privacy-lock@praveshishere.github.io   # off immediately, no logout needed
rm -rf ~/.local/share/gnome-shell/extensions/privacy-lock@praveshishere.github.io
rm -rf ~/.config/privacy-lock                     # deletes the stored PIN hash
```

## Known limitations

- Wayland-only correctness target; not tested under X11 GNOME sessions or
  non-GNOME compositors.
- Not real authentication security — bypassable from another TTY or SSH
  session (see above; this is by design of how Wayland/GNOME session
  isolation works, not a fixable gap).
- No system tray icon; trigger via hotkey or the D-Bus command only.
- If `gnome-shell` crashes or is restarted while locked, the lock state does
  not persist — the screen returns unlocked. Pair this with GNOME's real
  lock (`Super+L`) for anything that actually matters.
- The overlay draws nothing but a low-opacity colour wash (tunable in
  preferences, 0 to disable): the real desktop is simply left rendering
  underneath it. So the view is genuinely live —
  windows opened, closed, moved, or switched to another workspace while
  locked all show up, video keeps playing, and there is no capture loop,
  no clone, and no GPU blur pass to pay for.
- Because everything stays legible through the tint, **this hides no content
  whatsoever**. It is an input lock, not a privacy screen.
- While locked, the extension holds an `org.gnome.SessionManager` idle and
  suspend inhibit, so GNOME's own screen shield will not blank and lock on
  top of this overlay. The inhibit only *prevents* the session going idle,
  it cannot undo it, so the auto-lock is always armed at least 30s ahead of
  `org.gnome.desktop.session idle-delay` — otherwise both fire together and
  the real lock wins the race. Your configured "lock after inactivity" is
  capped to that, so setting it at or above the session's idle-delay
  silently gets pulled slightly earlier rather than breaking. `Super+L` is likewise inert while locked — the modal
  grab runs at `Shell.ActionMode.NONE`, which the shortcut does not match.
  A lid close or an explicit suspend still locks for real on resume; the
  session owns that, and no extension can override it.
