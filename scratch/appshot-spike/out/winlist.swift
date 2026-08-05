
import CoreGraphics
import Foundation
let opts = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { exit(2) }
var out: [[String: Any]] = []
for w in list {
  guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
  guard let num = w[kCGWindowNumber as String] as? Int else { continue }
  let pid = w[kCGWindowOwnerPID as String] as? Int ?? -1
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  let name = w[kCGWindowName as String] as? String ?? ""
  var bx = 0.0, by = 0.0, bw = 0.0, bh = 0.0
  if let b = w[kCGWindowBounds as String] as? [String: Any] {
    bx = (b["X"] as? Double) ?? 0; by = (b["Y"] as? Double) ?? 0
    bw = (b["Width"] as? Double) ?? 0; bh = (b["Height"] as? Double) ?? 0
  }
  out.append(["windowId": num, "pid": pid, "owner": owner, "title": name,
              "x": bx, "y": by, "width": bw, "height": bh])
}
let data = try JSONSerialization.data(withJSONObject: out, options: [])
print(String(data: data, encoding: .utf8)!)
