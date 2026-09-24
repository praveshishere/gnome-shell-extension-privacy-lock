// SPDX-FileCopyrightText: 2026 praveshishere
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Adw from 'gi://Adw';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as PinStore from './pinStore.js';

const CAVEAT_TEXT =
    'This is a privacy overlay, not OS-grade authentication. Anyone with ' +
    'another TTY (Ctrl+Alt+F3) or a remote shell can disable this extension ' +
    'or restart GNOME Shell, bypassing the PIN entirely. Keep GNOME’s ' +
    'real lock screen (Super+L) as your actual security boundary — use ' +
    'this tool only as a quick cover for short absences.';

export default class PrivacyLockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        page.add(this._buildPinGroup(window));
        page.add(this._buildAppearanceGroup(settings));
        page.add(this._buildBehaviorGroup(settings));
        page.add(this._buildShortcutGroup(window, settings));
        page.add(this._buildCaveatGroup());

        window.add(page);
    }

    _buildPinGroup(window) {
        const group = new Adw.PreferencesGroup({ title: 'PIN' });

        const row = new Adw.ActionRow({
            title: PinStore.hasPin() ? 'Change PIN' : 'Set PIN',
            subtitle: PinStore.hasPin()
                ? 'A PIN is currently set'
                : 'No PIN set — locking is disabled until one is set',
        });

        const button = new Gtk.Button({
            label: PinStore.hasPin() ? 'Change…' : 'Set…',
            valign: Gtk.Align.CENTER,
        });
        button.connect('clicked', () => this._openPinDialog(window, row, button));
        row.add_suffix(button);
        group.add(row);

        return group;
    }

    _openPinDialog(window, row, button) {
        const dialog = new Adw.MessageDialog({
            transient_for: window,
            heading: 'Set PIN',
            body: 'Choose a PIN used to unlock the privacy overlay.',
        });

        const entry = new Gtk.PasswordEntry({
            show_peek_icon: true,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        dialog.set_extra_child(entry);

        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('save', 'Save');
        dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('save');

        dialog.connect('response', (_dlg, response) => {
            if (response === 'save') {
                const pin = entry.get_text();
                if (pin.length > 0) {
                    PinStore.setPin(pin);
                    row.set_title('Change PIN');
                    row.set_subtitle('A PIN is currently set');
                    button.set_label('Change…');
                }
            }
            dialog.destroy();
        });

        dialog.present();
    }

    _buildAppearanceGroup(settings) {
        const group = new Adw.PreferencesGroup({ title: 'Appearance' });

        const strength = new Adw.SpinRow({
            title: 'Tint strength',
            subtitle: 'How strongly the screen is washed while locked. The desktop stays visible through it; 0 makes the overlay invisible.',
            digits: 2,
            adjustment: new Gtk.Adjustment({
                lower: 0.0, upper: 0.6, step_increment: 0.01, page_increment: 0.05,
            }),
        });
        settings.bind('tint-opacity', strength, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(strength);

        const colorRow = new Adw.ActionRow({
            title: 'Tint colour',
            subtitle: 'A neutral light grey reads as a film over the desktop; saturated colours read as a colour cast.',
        });

        const rgba = new Gdk.RGBA();
        if (!rgba.parse(settings.get_string('tint-color')))
            rgba.parse('#ededed');

        const colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({ with_alpha: false }),
            rgba,
            valign: Gtk.Align.CENTER,
        });
        // Store as #rrggbb only; the alpha lives in tint-opacity, so
        // to_string()'s rgb()/rgba() form would not round-trip.
        colorButton.connect('notify::rgba', () => {
            const c = colorButton.get_rgba();
            const hex = [c.red, c.green, c.blue]
                .map(v => Math.round(v * 255).toString(16).padStart(2, '0'))
                .join('');
            settings.set_string('tint-color', `#${hex}`);
        });
        colorRow.add_suffix(colorButton);
        group.add(colorRow);

        return group;
    }

    _buildBehaviorGroup(settings) {
        const group = new Adw.PreferencesGroup({ title: 'Auto-lock' });

        const spinRow = new Adw.SpinRow({
            title: 'Lock after inactivity',
            subtitle: 'Minutes of idle time before the overlay appears automatically (0 disables auto-lock)',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 120, step_increment: 1, page_increment: 5,
            }),
        });
        settings.bind('inactivity-minutes', spinRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(spinRow);

        return group;
    }

    _buildShortcutGroup(window, settings) {
        const group = new Adw.PreferencesGroup({ title: 'Keyboard shortcut' });

        const row = new Adw.ActionRow({ title: 'Lock now' });
        const label = new Gtk.ShortcutLabel({
            valign: Gtk.Align.CENTER,
            disabled_text: 'Unset',
        });

        const updateLabel = () => {
            const [accel] = settings.get_strv('lock-keybinding');
            label.set_accelerator(accel ?? '');
        };
        updateLabel();

        const button = new Gtk.Button({
            label: 'Set Shortcut…',
            valign: Gtk.Align.CENTER,
        });
        button.connect('clicked', () => this._captureShortcut(window, settings, updateLabel));

        row.add_suffix(label);
        row.add_suffix(button);
        group.add(row);

        return group;
    }

    _captureShortcut(window, settings, updateLabel) {
        const dialog = new Adw.MessageDialog({
            transient_for: window,
            heading: 'Set Shortcut',
            body: 'Press the new key combination, or Escape to cancel.',
        });
        dialog.add_response('cancel', 'Cancel');

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_ctrl, keyval, keycode, state) => {
            if (keyval === Gdk.KEY_Escape) {
                dialog.destroy();
                return Gtk.EVENT_STOP;
            }

            const mask = state & Gtk.accelerator_get_default_mod_mask();
            if (Gtk.accelerator_valid(keyval, mask)) {
                const accel = Gtk.accelerator_name(keyval, mask);
                settings.set_strv('lock-keybinding', [accel]);
                updateLabel();
                dialog.destroy();
            }
            return Gtk.EVENT_STOP;
        });
        dialog.add_controller(controller);

        dialog.present();
    }

    _buildCaveatGroup() {
        const group = new Adw.PreferencesGroup();
        const label = new Gtk.Label({
            label: CAVEAT_TEXT,
            wrap: true,
            xalign: 0,
            margin_top: 6,
            margin_bottom: 6,
            css_classes: ['dim-label'],
        });
        group.add(label);
        return group;
    }
}