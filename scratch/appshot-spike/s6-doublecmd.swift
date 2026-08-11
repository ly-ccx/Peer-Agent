// S6: double-Command (left ⌘ + right ⌘ simultaneously) global detection spike.
//
// Approach: NSEvent global monitor for .flagsChanged, using device-specific
// modifier masks to tell LEFT (0x08) from RIGHT (0x10) Command.
// Requirement per Apple docs: global monitors need Accessibility trust
// (AXIsProcessTrusted). We print trust state and emit DOUBLE_CMD lines to
// stdout for the Node side to consume.
//
// Exit contract:
//   startup line: TRUSTED=true|false
//   on detection: DOUBLE_CMD <epoch-ms>
// The parent process kills us; we also self-exit after --timeout seconds.
import AppKit
import ApplicationServices
import Foundation

let NX_DEVICELCMDKEYMASK: UInt = 0x00000008
let NX_DEVICERCMDKEYMASK: UInt = 0x00000010

let trusted = AXIsProcessTrusted()
print("TRUSTED=\(trusted)")
fflush(stdout)

var timeoutSeconds = 60.0
if let idx = CommandLine.arguments.firstIndex(of: "--timeout"),
   idx + 1 < CommandLine.arguments.count,
   let value = Double(CommandLine.arguments[idx + 1]) {
  timeoutSeconds = value
}

var lastFire: TimeInterval = 0

NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { event in
  let raw = UInt(event.modifierFlags.rawValue)
  let left = raw & NX_DEVICELCMDKEYMASK != 0
  let right = raw & NX_DEVICERCMDKEYMASK != 0
  if left && right {
    let now = Date().timeIntervalSince1970
    // debounce: one fire per 500ms window
    if now - lastFire > 0.5 {
      lastFire = now
      print("DOUBLE_CMD \(Int(now * 1000))")
      fflush(stdout)
    }
  }
}

DispatchQueue.main.asyncAfter(deadline: .now() + timeoutSeconds) {
  print("TIMEOUT")
  fflush(stdout)
  exit(0)
}

RunLoop.main.run()
