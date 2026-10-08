// Prints display and window geometry in global top-left coordinates (points).
//
//   swift displays.swift displays
//     -> one line per display: <kind> <x> <y> <width> <height> <name>
//        kind is "builtin" or "external".
//   swift displays.swift mainscale
//     -> backing scale factor of the menu-bar display.
//   swift displays.swift window <pid>
//     -> "<x> <y> <width> <height> <display-kind>" for the largest on-screen
//        window owned by <pid>, where display-kind is the display that holds
//        the window center.
import AppKit

struct Display {
  let kind: String
  let rect: CGRect
  let name: String
}

func displays() -> [Display] {
  return NSScreen.screens.map { screen in
    let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? UInt32 ?? 0
    let bounds = CGDisplayBounds(number)
    let kind = CGDisplayIsBuiltin(number) != 0 ? "builtin" : "external"
    return Display(kind: kind, rect: bounds, name: screen.localizedName)
  }
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "displays" {
case "displays":
  for d in displays() {
    print(d.kind, Int(d.rect.minX), Int(d.rect.minY), Int(d.rect.width), Int(d.rect.height), d.name)
  }
case "mainscale":
  print(Int(NSScreen.screens.first?.backingScaleFactor ?? 1))
case "window":
  guard args.count > 2, let pid = Int32(args[2]) else {
    FileHandle.standardError.write("usage: displays.swift window <pid>\n".data(using: .utf8)!)
    exit(2)
  }
  let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  let rects = info.compactMap { entry -> CGRect? in
    guard (entry[kCGWindowOwnerPID as String] as? Int32) == pid,
          (entry[kCGWindowLayer as String] as? Int) == 0,
          let boundsDict = entry[kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: boundsDict) else { return nil }
    return rect
  }
  guard let rect = rects.max(by: { $0.width * $0.height < $1.width * $1.height }) else {
    print("none")
    exit(1)
  }
  let center = CGPoint(x: rect.midX, y: rect.midY)
  let kind = displays().first(where: { $0.rect.contains(center) })?.kind ?? "offscreen"
  print(Int(rect.minX), Int(rect.minY), Int(rect.width), Int(rect.height), kind)
default:
  FileHandle.standardError.write("unknown command\n".data(using: .utf8)!)
  exit(2)
}
