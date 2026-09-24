// SPDX-FileCopyrightText: 2026 praveshishere
// SPDX-License-Identifier: GPL-2.0-or-later

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

// Fallback if the stored colour is unparseable. A neutral light grey rather
// than a tinted one: anything saturated reads as a colour cast over the
// desktop, where a near-white wash reads as a film laid on top of it.
const FALLBACK_RGB = '237, 237, 237';

/**
 * Expand a stored #rrggbb colour into the "r, g, b" St wants inside rgba().
 * The colour and its alpha are separate settings, so they have to be
 * recombined here rather than stored as one CSS value.
 */
function rgbTriplet(hex) {
    const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex?.trim() ?? '');
    if (!match)
        return FALLBACK_RGB;
    return [1, 2, 3].map(i => parseInt(match[i], 16)).join(', ');
}

/**
 * A screen-sized actor placed over the desktop while locked.
 *
 * It paints nothing but a low-opacity colour wash, so the real desktop keeps
 * rendering underneath at full framerate and stays legible through it. What
 * shows through is therefore the genuinely live system — windows opened,
 * closed, moved, or switched to another workspace while locked all appear,
 * which the old mirrored backdrop could not do (it cloned the window list
 * once, at lock time, and never updated).
 *
 * The wash is what makes the lock evident at a glance; at tintOpacity 0 the
 * shield is completely invisible and the PIN card is the only indication.
 * Both the colour and its opacity are settings read at lock time, so they
 * can be retuned without reloading the shell.
 *
 * The actor is also reactive, so pointer events land on the modal grab
 * instead of the windows below, and spans the whole stage via a
 * BindConstraint so it keeps covering everything if the monitor layout
 * changes while locked.
 */
export const LockShield = GObject.registerClass(
class LockShield extends St.Widget {
    _init(tintColor, tintOpacity) {
        super._init({
            reactive: true,
            style: `background-color: rgba(${rgbTriplet(tintColor)}, ${tintOpacity});`,
        });

        this.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
    }
});

/**
 * The PIN entry card: label, password entry, error/lockout message.
 * Shown once, centered on the primary monitor.
 */
export const PinPrompt = GObject.registerClass({
    Signals: {
        'submit': { param_types: [GObject.TYPE_STRING] },
    },
}, class PinPrompt extends St.BoxLayout {
    _init() {
        super._init({
            vertical: true,
            style_class: 'privacy-lock-pin-box',
            style: 'background-color: rgba(0,0,0,0.75); border: 1px solid rgba(255,255,255,0.15); border-radius: 18px; padding: 32px; spacing: 14px;',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._label = new St.Label({
            text: 'Enter PIN to unlock',
            style: 'color: white; font-size: 18px; font-weight: bold;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

        this._entry = new St.Entry({
            style: 'min-width: 220px; font-size: 16px; padding: 8px 12px;',
            can_focus: true,
        });
        this._entry.clutter_text.set_password_char('•');
        this._entry.clutter_text.set_input_purpose(Clutter.InputContentPurpose.PASSWORD);
        this._entry.clutter_text.connect('activate', () => this._onSubmit());
        this.add_child(this._entry);

        this._message = new St.Label({
            text: '',
            style: 'color: #ff8080; font-size: 13px;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._message.hide();
        this.add_child(this._message);
    }

    _onSubmit() {
        if (!this._entry.reactive)
            return;
        this.emit('submit', this._entry.get_text());
    }

    focus() {
        global.stage.set_key_focus(this._entry.clutter_text);
    }

    clear() {
        this._entry.set_text('');
    }

    shake() {
        const startX = this.translation_x;
        const offsets = [-14, 14, -10, 10, -6, 6, 0];
        let i = 0;
        const step = () => {
            if (i >= offsets.length) {
                this.translation_x = startX;
                return;
            }
            this.ease({
                translation_x: startX + offsets[i],
                duration: 45,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: step,
            });
            i++;
        };
        step();
    }

    showError(text) {
        this._message.set_text(text);
        this._message.show();
    }

    clearError() {
        this._message.set_text('');
        this._message.hide();
    }

    setLocked(locked) {
        this._entry.reactive = !locked;
        this._entry.can_focus = !locked;
    }
});