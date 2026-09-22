// Native lifecycle controller source. It uses AppKit/NSWorkspace, not AppleScript.
export const CHATGPT_CONTROLLER_SOURCE = String.raw`import AppKit
import Foundation

let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
RunLoop.current.run(until: Date().addingTimeInterval(0.25))

let args = Array(CommandLine.arguments.dropFirst())
let action = args.first ?? "state"
let bundleID = args.count > 1 ? args[1] : "com.openai.codex"
let appPath = args.count > 2 ? args[2] : "/Applications/ChatGPT.app"

// An empty GUI session must not be treated as proof that ChatGPT is stopped.
if NSWorkspace.shared.runningApplications.isEmpty {
    fputs("No macOS GUI applications are visible. Run MST in the logged-in desktop session with permission to access LaunchServices; a restricted shell cannot safely manage this app.\n", stderr)
    exit(1)
}

func apps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == bundleID }
}

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
       let text = String(data: data, encoding: .utf8) { print(text) }
}

switch action {
case "state":
    emit(["running": !apps().isEmpty, "instances": apps().count])
case "stop":
    let current = apps()
    if current.count > 1 { fputs("Multiple ChatGPT instances; refusing termination.\n", stderr); exit(1) }
    for app in current {
        if !app.terminate() { fputs("ChatGPT declined graceful termination.\n", stderr); exit(1) }
    }
    let deadline = Date().addingTimeInterval(20)
    while !apps().isEmpty && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    if !apps().isEmpty { fputs("ChatGPT did not quit; no force termination attempted.\n", stderr); exit(1) }
    emit(["stopped": true])
case "start":
    if !apps().isEmpty { fputs("ChatGPT is already running.\n", stderr); exit(1) }
    let appURL = URL(fileURLWithPath: appPath)
    guard let bundle = Bundle(url: appURL), bundle.bundleIdentifier == bundleID else {
        fputs("ChatGPT app bundle identity did not match.\n", stderr); exit(1)
    }
    let options = NSWorkspace.OpenConfiguration()
    options.activates = true
    let data = FileHandle.standardInput.readDataToEndOfFile()
    if !data.isEmpty {
        guard let environment = try? JSONSerialization.jsonObject(with: data) as? [String: String] else {
            fputs("Invalid launch environment.\n", stderr); exit(1)
        }
        if !environment.isEmpty {
            options.environment = ProcessInfo.processInfo.environment.merging(environment) { _, configured in configured }
        }
    }
    var done = false
    var succeeded = false
    var launchError: NSError?
    NSWorkspace.shared.openApplication(at: appURL, configuration: options) { app, error in
        succeeded = app?.bundleIdentifier == bundleID && error == nil
        launchError = error as NSError?
        done = true
    }
    let deadline = Date().addingTimeInterval(30)
    while !done && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    if !succeeded {
        if let error = launchError {
            fputs("ChatGPT launch failed: \(error.domain) code=\(error.code): \(error.localizedDescription)\n", stderr)
        } else {
            fputs(done ? "ChatGPT launch returned an unexpected bundle identity.\n" : "ChatGPT launch timed out.\n", stderr)
        }
        exit(1)
    }
    emit(["launched": true])
default:
    fputs("Expected state, start, or stop.\n", stderr)
    exit(1)
}
`;
