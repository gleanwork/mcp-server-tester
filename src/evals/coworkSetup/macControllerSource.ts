// Native controller source is embedded so installed packages need no helper scripts.
export const MAC_COWORK_CONTROLLER_SOURCE = String.raw`import AppKit
import ApplicationServices
import Foundation

// Initialize AppKit without a Dock icon/window; never request Accessibility permission.
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
RunLoop.current.run(until: Date().addingTimeInterval(0.5))
let bundleID = "com.anthropic.claudefordesktop"
func apps() -> [NSRunningApplication] {
    return NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == bundleID }
}
func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
       let text = String(data: data, encoding: .utf8) { print(text) }
}
let action = CommandLine.arguments.dropFirst().first ?? "state"
switch action {
case "state":
    emit(["running": !apps().isEmpty, "instances": apps().count,
          "workspaceApplicationCount": NSWorkspace.shared.runningApplications.count,
          "claudeBundleReadable": Bundle(url: URL(fileURLWithPath: "/Applications/Claude.app"))?.bundleIdentifier == bundleID,
          "accessibilityTrusted": AXIsProcessTrusted()])
case "stop":
    let current = apps()
    if current.count > 1 { fputs("Multiple Claude instances; refusing termination.\n", stderr); exit(1) }
    for app in current {
        if !app.terminate() { fputs("Claude declined graceful termination.\n", stderr); exit(1) }
    }
    let deadline = Date().addingTimeInterval(15)
    while !apps().isEmpty && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    if !apps().isEmpty { fputs("Claude did not quit; no force termination attempted.\n", stderr); exit(1) }
    emit(["stopped": true])
case "start":
    if !apps().isEmpty { fputs("Claude is already running.\n", stderr); exit(1) }
    let options = NSWorkspace.OpenConfiguration()
    options.activates = true
    var done = false
    var succeeded = false
    var failureCode: Int? = nil
    var failureDomain: String? = nil
    var reason = "launch-timeout"
    NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: "/Applications/Claude.app"), configuration: options) { app, error in
        succeeded = app?.bundleIdentifier == bundleID && error == nil
        failureCode = (error as NSError?)?.code
        let domain = (error as NSError?)?.domain
        if ["NSCocoaErrorDomain", "NSOSStatusErrorDomain", "NSPOSIXErrorDomain"].contains(domain ?? "") { failureDomain = domain }
        reason = error == nil ? "application-not-resolved" : "launch-services-error"
        done = true
    }
    let deadline = Date().addingTimeInterval(20)
    while !done && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    if !succeeded {
        var result: [String: Any] = ["launched": false, "reason": reason]
        if let code = failureCode { result["code"] = code }
        if let domain = failureDomain { result["domain"] = domain }
        emit(result)
        exit(1)
    }
    emit(["launched": true])
default:
    fputs("Expected state, start, or stop.\n", stderr)
    exit(1)
}
`;
