import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const CONFIG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'privacy-lock']);
const PIN_FILE = GLib.build_filenamev([CONFIG_DIR, 'pin.hash']);

const SALT_BYTES = 16;

// Stored as "v2:<iterations>:<salt>:<hash>". The count is written into the
// file rather than assumed, so it can be raised later without invalidating
// PINs already on disk.
const FORMAT_VERSION = 'v2';

// A PIN is short and low-entropy, so a single hash round is brute-forceable
// in seconds by anyone who reads the file. Stretching does not make a 4-digit
// PIN strong — nothing can — it just removes the cheapest attack. 50k rounds
// costs ~220ms here, which is the most that can be spent without the unlock
// visibly stalling: this runs on the compositor's main loop, so the cost is a
// frame hitch in gnome-shell, not a background thread.
const ITERATIONS = 50000;

function _stretch(salt, pin, iterations) {
    const encoder = new TextEncoder();
    let digest = `${salt}:${pin}`;
    for (let i = 0; i < iterations; i++) {
        const checksum = GLib.Checksum.new(GLib.ChecksumType.SHA256);
        checksum.update(encoder.encode(digest));
        digest = checksum.get_string();
    }
    return digest;
}

/**
 * Compare without an early return, so the time taken does not reveal how many
 * leading characters were correct. Both inputs are fixed-length hex digests
 * here, so length never differs in practice, but guard anyway.
 */
function _constantTimeEquals(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function _randomSaltHex() {
    // Draw from /dev/urandom rather than GLib.Rand, which is not
    // cryptographically strong.
    const file = Gio.File.new_for_path('/dev/urandom');
    const stream = file.read(null);
    const bytes = stream.read_bytes(SALT_BYTES, null);
    stream.close(null);
    const arr = bytes.get_data();
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function _ensureConfigDir() {
    const dir = Gio.File.new_for_path(CONFIG_DIR);
    if (!dir.query_exists(null))
        GLib.mkdir_with_parents(CONFIG_DIR, 0o700);
}

function _restrictToOwner(path) {
    const file = Gio.File.new_for_path(path);
    const info = new Gio.FileInfo();
    info.set_attribute_uint32('unix::mode', 0o600);
    file.set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);
}

function _write(contents) {
    _ensureConfigDir();
    const file = Gio.File.new_for_path(PIN_FILE);
    file.replace_contents(
        new TextEncoder().encode(contents),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    _restrictToOwner(PIN_FILE);
}

/**
 * Parse either the current "v2:<iterations>:<salt>:<hash>" form or the
 * original unversioned "<salt>:<hash>", which was a single unstretched
 * round. Legacy records still verify so an existing PIN keeps working; they
 * are rewritten in the new form on the next successful unlock.
 */
function _parse(text) {
    const parts = text.trim().split(':');
    if (parts[0] === FORMAT_VERSION) {
        if (parts.length !== 4)
            return null;
        const iterations = Number.parseInt(parts[1], 10);
        if (!Number.isInteger(iterations) || iterations < 1)
            return null;
        return { iterations, salt: parts[2], hash: parts[3], legacy: false };
    }
    if (parts.length === 2)
        return { iterations: 1, salt: parts[0], hash: parts[1], legacy: true };
    return null;
}

export function hasPin() {
    return GLib.file_test(PIN_FILE, GLib.FileTest.EXISTS);
}

export function setPin(pin) {
    if (!pin || pin.length === 0)
        throw new Error('PIN must not be empty');

    const salt = _randomSaltHex();
    const hash = _stretch(salt, pin, ITERATIONS);
    _write(`${FORMAT_VERSION}:${ITERATIONS}:${salt}:${hash}`);
}

export function clearPin() {
    const file = Gio.File.new_for_path(PIN_FILE);
    if (file.query_exists(null))
        file.delete(null);
}

export function verify(candidate) {
    if (!hasPin())
        return false;

    const [ok, contents] = GLib.file_get_contents(PIN_FILE);
    if (!ok)
        return false;

    const record = _parse(new TextDecoder().decode(contents));
    if (!record)
        return false;

    const pin = candidate ?? '';
    const legacyDigest = record.legacy
        ? _digestLegacy(record.salt, pin)
        : _stretch(record.salt, pin, record.iterations);

    if (!_constantTimeEquals(legacyDigest, record.hash))
        return false;

    // Correct PIN against an old record: re-save it stretched, so the weak
    // form does not persist once we know the plaintext.
    if (record.legacy || record.iterations < ITERATIONS) {
        try {
            setPin(pin);
        } catch (e) {
            logError(e, 'privacy-lock: could not upgrade stored PIN');
        }
    }

    return true;
}

/** The original format: one SHA-256 over salt immediately followed by pin. */
function _digestLegacy(salt, pin) {
    const checksum = GLib.Checksum.new(GLib.ChecksumType.SHA256);
    checksum.update(new TextEncoder().encode(salt + pin));
    return checksum.get_string();
}
