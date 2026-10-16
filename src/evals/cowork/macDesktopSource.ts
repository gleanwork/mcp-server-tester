/**
 * The Swift helper behind the macOS Computer Use desktop: one primitive per
 * run, JSON out, no eval logic. Embedded so an installed package needs no
 * helper files. Text arrives on stdin, never in arguments.
 *
 * - `permissions`: `{ screenRecording, accessibility }`, read-only.
 * - `frontmost`: `{ name }`, the frontmost application's name.
 * - `screen`: `{ width, height }`, the main display in points.
 * - `cursor`: `{ x, y }`, the cursor in points.
 * - `move x y`, `click x y left|right|middle clicks`, `drag x1 y1 x2 y2`,
 *   `scroll x y vertical horizontal` (lines; positive is up or left).
 * - `chord code...`: presses the virtual key codes in order and releases them
 *   in reverse, with modifier flags set for the modifiers held.
 * - `type`: posts stdin as Unicode keyboard events.
 */
export const MAC_DESKTOP_HELPER_SOURCE = String.raw`import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
       let text = String(data: data, encoding: .utf8) { print(text) }
}
func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(2)
}
func number(_ index: Int) -> Double {
    let args = CommandLine.arguments
    guard index < args.count, let value = Double(args[index]), value.isFinite else { fail("bad argument") }
    return value
}
func point(_ index: Int) -> CGPoint { CGPoint(x: number(index), y: number(index + 1)) }
func post(_ event: CGEvent?) {
    guard let event = event else { fail("event") }
    event.post(tap: .cghidEventTap)
}
func moveMouse(_ to: CGPoint) {
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: to, mouseButton: .left))
}
let modifierFlags: [CGKeyCode: CGEventFlags] = [
    0x37: .maskCommand, 0x36: .maskCommand, 0x38: .maskShift, 0x3C: .maskShift,
    0x3A: .maskAlternate, 0x3D: .maskAlternate, 0x3B: .maskControl, 0x3E: .maskControl,
    0x3F: .maskSecondaryFn,
]

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "permissions":
    emit(["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()])
case "frontmost":
    if let name = NSWorkspace.shared.frontmostApplication?.localizedName { emit(["name": name]) } else { emit([:]) }
case "screen":
    let bounds = CGDisplayBounds(CGMainDisplayID())
    emit(["width": Double(bounds.width), "height": Double(bounds.height)])
case "cursor":
    let location = CGEvent(source: nil)?.location ?? .zero
    emit(["x": Int(location.x), "y": Int(location.y)])
case "move":
    moveMouse(point(2))
    emit(["ok": true])
case "click":
    let at = point(2)
    let button = args.count > 4 ? args[4] : "left"
    let clicks = Int(number(5))
    guard clicks >= 1 && clicks <= 3 else { fail("bad click count") }
    let (down, up, mouseButton): (CGEventType, CGEventType, CGMouseButton) =
        button == "right" ? (.rightMouseDown, .rightMouseUp, .right)
        : button == "middle" ? (.otherMouseDown, .otherMouseUp, .center)
        : (.leftMouseDown, .leftMouseUp, .left)
    moveMouse(at)
    for state in 1...clicks {
        for type in [down, up] {
            let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: at, mouseButton: mouseButton)
            event?.setIntegerValueField(.mouseEventClickState, value: Int64(state))
            post(event)
        }
    }
    emit(["ok": true])
case "drag":
    let start = point(2), end = point(4)
    moveMouse(start)
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left))
    let steps = 20
    for step in 1...steps {
        let t = CGFloat(step) / CGFloat(steps)
        let at = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
        post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: at, mouseButton: .left))
        usleep(20_000)
    }
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left))
    emit(["ok": true])
case "scroll":
    moveMouse(point(2))
    post(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2,
                 wheel1: Int32(number(4)), wheel2: Int32(number(5)), wheel3: 0))
    emit(["ok": true])
case "chord":
    let codes = args.dropFirst(2).map { value -> CGKeyCode in
        guard let code = UInt16(value), code < 128 else { fail("bad key code") }
        return code
    }
    guard !codes.isEmpty else { fail("no keys") }
    var held: CGEventFlags = []
    for code in codes {
        if let flag = modifierFlags[code] { held.insert(flag) }
        let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
        event?.flags = held
        post(event)
    }
    for code in codes.reversed() {
        let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
        event?.flags = held
        post(event)
        if let flag = modifierFlags[code] { held.remove(flag) }
    }
    emit(["ok": true])
case "type":
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let text = String(data: input, encoding: .utf8) else { fail("text is not UTF-8") }
    // At most 16 UTF-16 units per event, never splitting a character.
    var chunk: [UniChar] = []
    func flush() {
        guard !chunk.isEmpty else { return }
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
            event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            post(event)
        }
        chunk.removeAll()
        usleep(10_000)
    }
    for character in text {
        let units = Array(String(character).utf16)
        if chunk.count + units.count > 16 { flush() }
        chunk.append(contentsOf: units)
    }
    flush()
    emit(["ok": true])
default:
    fail("unknown command")
}
`;
