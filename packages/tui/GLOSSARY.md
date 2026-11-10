# Glossary: pi-tui

Context: `packages/tui` (`@earendil-works/pi-tui`). Source: its README. Map: [../../GLOSSARY-MAP.md](../../GLOSSARY-MAP.md).

**TUI**: the shared interface for managing components, focus, overlays, input, lifecycle and rendering. Choose a renderer when the app starts.

**TuiMainScreen**: renders into the main terminal buffer and keeps the terminal's scrollback.

**TuiAltScreen**: renders a fixed-height viewport in the alternate buffer. The app owns scrolling. On stop it restores the main buffer and prints the full document.

**Component**: anything with `render(width)`, which returns one string per line. Each line must not exceed `width`. `invalidate()` is required.

**Differential rendering**: only changed lines or viewport rows are written. Synchronized output (CSI 2026) makes each update atomic.

**Overlay**: a component drawn on top of existing content, such as a dialog or menu. Positioned by anchor, percentage or absolute row and column.

**Layout root, stack and region**: on `TuiAltScreen`, `VStack` and `HStack` divide the terminal height into regions. Each stack entry sets `basis`, `grow`, `shrink` and `minSize`. Layout is rebuilt for every frame.

**ScrollView**: owns scrolling for one region. It is the primary scroll view when it receives the alternate-screen keyboard navigation.

**Capturing input**: a focused component that sets `capturesViewportInput` receives PageUp and PageDown instead of the viewport. `SelectList`, `SettingsList` and `Editor` do this while their list is open.

**Mouse event (`TuiMouseEvent`)**: normalized pointer input on `TuiAltScreen`. A handler returns a result with `handled`, `capture`, `focus` or `render`. `MouseRegion` adds mouse behavior without changing rendering.
