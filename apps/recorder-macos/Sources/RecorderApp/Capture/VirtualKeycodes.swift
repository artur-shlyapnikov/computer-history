import Foundation

/// Virtual-keycode → normalized name table for SHORTCUT descriptions only
/// (e.g. "cmd+c"). This is deliberately the ONLY place key identities are
/// turned into anything human-readable; no character payload from CGEvent is
/// ever read (grep audit: no text-payload API may appear in input
/// paths). Names are layout-independent virtual keycodes, not typed glyphs.
enum KeyCodeNames {
    /// Apple ANSI virtual keycodes (HIToolbox Events.h values).
    static let names: [UInt32: String] = [
        0: "a", 1: "s", 2: "d", 3: "f", 4: "h", 5: "g", 6: "z", 7: "x",
        8: "c", 9: "v", 11: "b", 12: "q", 13: "w", 14: "e", 15: "r",
        16: "y", 17: "t", 18: "1", 19: "2", 20: "3", 21: "4", 22: "6",
        23: "5", 24: "equal", 25: "9", 26: "7", 27: "minus", 28: "8",
        29: "0", 30: "rightbracket", 31: "o", 32: "u", 33: "leftbracket",
        34: "i", 35: "p", 36: "return", 37: "l", 38: "j", 39: "quote",
        40: "k", 41: "semicolon", 42: "backslash", 43: "comma", 44: "slash",
        45: "n", 46: "m", 47: "period", 48: "tab", 49: "space",
        50: "grave", 51: "delete", 53: "escape", 55: "cmd", 56: "shift",
        57: "capslock", 58: "option", 59: "control", 60: "rightshift",
        61: "rightoption", 62: "rightcontrol", 63: "fn",
        65: "keypaddecimal", 67: "keypadmultiply", 69: "keypadplus",
        71: "f17", 75: "keypaddivide", 76: "keypadenter", 78: "keypadminus",
        81: "keypadequal", 82: "keypad0", 83: "keypad1", 84: "keypad2",
        85: "keypad3", 86: "keypad4", 87: "keypad5", 88: "keypad6",
        89: "keypad7", 91: "keypad8", 92: "keypad9",
        96: "f5", 97: "f6", 98: "f7", 99: "f3", 100: "f8", 101: "f9",
        103: "f11", 105: "f13", 106: "f16", 107: "f14", 109: "f10",
        111: "f12", 113: "f15", 114: "help", 115: "home", 116: "pageup",
        117: "forwarddelete", 118: "f4", 119: "end", 120: "f2",
        121: "pagedown", 122: "f1", 123: "leftarrow", 124: "rightarrow",
        125: "downarrow", 126: "uparrow",
    ]

    static func name(for keycode: UInt32) -> String? {
        names[keycode]
    }
}
