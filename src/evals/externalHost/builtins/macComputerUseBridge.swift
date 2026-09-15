import ApplicationServices
import Cocoa
import CoreGraphics
import Foundation

struct Command: Decodable {
  let op: String
  let app: String
  let index: Int?
  let value: String?
  let key: String?
}

struct Response: Encodable {
  let ok: Bool
  let state: String?
  let screenshot: String?
  let error: String?
}

var indexedElements: [Int: AXUIElement] = [:]

func main() {
  while let line = readLine() {
    do {
      let command = try JSONDecoder().decode(Command.self, from: Data(line.utf8))
      let response = try execute(command)
      write(Response(ok: true, state: response.state, screenshot: response.screenshot, error: nil))
    } catch {
      write(Response(ok: false, state: nil, screenshot: nil, error: String(describing: error)))
    }
  }
}

func execute(_ command: Command) throws -> (state: String?, screenshot: String?) {
  guard let application = runningApplication(named: command.app) else {
    throw BridgeError.appNotRunning(command.app)
  }
  let root = AXUIElementCreateApplication(application.processIdentifier)
  switch command.op {
  case "observe":
    let state = observe(root)
    return (state, nil)
  case "click":
    guard let index = command.index, let element = indexedElements[index] else {
      throw BridgeError.nodeUnavailable(command.index ?? -1)
    }
    guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else {
      throw BridgeError.actionFailed("click")
    }
    return (nil, nil)
  case "setValue":
    guard let index = command.index, let value = command.value, let element = indexedElements[index] else {
      throw BridgeError.nodeUnavailable(command.index ?? -1)
    }
    guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef) == .success else {
      throw BridgeError.actionFailed("setValue")
    }
    return (nil, nil)
  case "pressKey":
    try pressKey(command.key ?? "")
    return (nil, nil)
  default:
    throw BridgeError.unknownOperation(command.op)
  }
}

func runningApplication(named name: String) -> NSRunningApplication? {
  NSWorkspace.shared.runningApplications.first {
    $0.localizedName?.caseInsensitiveCompare(name) == .orderedSame
  }
}

func observe(_ root: AXUIElement) -> String {
  indexedElements.removeAll(keepingCapacity: true)
  var lines: [String] = []
  var nextIndex = 0
  walk(root, depth: 0, lines: &lines, nextIndex: &nextIndex)
  return lines.joined(separator: "\n")
}

func walk(_ element: AXUIElement, depth: Int, lines: inout [String], nextIndex: inout Int) {
  let role = attributeString(element, kAXRoleAttribute)
  let title = attributeString(element, kAXTitleAttribute)
  let description = attributeString(element, kAXDescriptionAttribute)
  let value = attributeString(element, kAXValueAttribute)
  let url = attributeString(element, kAXURLAttribute)
  var fields: [String] = []
  if !role.isEmpty { fields.append(role) }
  if !title.isEmpty { fields.append("Title: \(title)") }
  if !description.isEmpty { fields.append("Description: \(description)") }
  if !value.isEmpty { fields.append("Value: \(value)") }
  if !url.isEmpty { fields.append("URL: \(url)") }
  if !fields.isEmpty {
    indexedElements[nextIndex] = element
    lines.append(String(repeating: "\t", count: depth) + "\(nextIndex) " + fields.joined(separator: ", "))
    nextIndex += 1
  }

  var childrenValue: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue) == .success,
        let children = childrenValue as? [AXUIElement] else { return }
  for child in children {
    walk(child, depth: depth + 1, lines: &lines, nextIndex: &nextIndex)
  }
}

func attributeString(_ element: AXUIElement, _ attribute: String) -> String {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return "" }
  if let string = value as? String { return string }
  if let url = value as? URL { return url.absoluteString }
  return ""
}

func pressKey(_ key: String) throws {
  let normalized = key.uppercased()
  let keyCode: CGKeyCode
  var flags: CGEventFlags = []
  switch normalized {
  case "RETURN", "ENTER": keyCode = 36
  case "CMD+1", "COMMAND+1": keyCode = 18; flags.insert(.maskCommand)
  case "CMD+2", "COMMAND+2": keyCode = 19; flags.insert(.maskCommand)
  case "ESCAPE", "ESC": keyCode = 53
  default: throw BridgeError.unsupportedKey(key)
  }
  guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
        let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
    throw BridgeError.actionFailed("pressKey")
  }
  down.flags = flags
  up.flags = flags
  down.post(tap: .cghidEventTap)
  up.post(tap: .cghidEventTap)
}

func write(_ response: Response) {
  let encoder = JSONEncoder()
  if let data = try? encoder.encode(response), let line = String(data: data, encoding: .utf8) {
    print(line, flush: true)
  }
}

enum BridgeError: Error, CustomStringConvertible {
  case appNotRunning(String)
  case nodeUnavailable(Int)
  case actionFailed(String)
  case unknownOperation(String)
  case unsupportedKey(String)

  var description: String {
    switch self {
    case .appNotRunning(let name): return "app not running: \(name)"
    case .nodeUnavailable(let index): return "node unavailable: \(index)"
    case .actionFailed(let action): return "action failed: \(action)"
    case .unknownOperation(let op): return "unknown operation: \(op)"
    case .unsupportedKey(let key): return "unsupported key: \(key)"
    }
  }
}

main()
