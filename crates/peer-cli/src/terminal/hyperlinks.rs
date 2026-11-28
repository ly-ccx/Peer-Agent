//! Terminal OSC 8 capability detection, URI resolution, and post-flush overlay painter.
//!
//! Modeled after xAI Grok Build's `HyperlinkRoute` + OSC 8 emitter while adapting cleanly
//! to Ratatui's double-buffered rendering: after `Terminal::draw` flushes buffer diffs,
//! visible links are painted via atomic DECSC/DECRC OSC 8 passes so terminals render native
//! `Cmd+Click` links without breaking Ratatui's cell diffing.

use peer_tui::ScreenHyperlink;
use ratatui::{
    buffer::{Buffer, Cell, CellDiffOption},
    layout::Rect,
    style::{Color, Modifier},
};
use std::{
    collections::HashMap,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

const MAX_OSC8_URI_BYTES: usize = 2048;
const MAX_URI_CACHE_ENTRIES: usize = 256;
const MAX_WORKSPACE_CHILD_SCAN: usize = 32;

/// Terminal capability route determining whether OSC 8 sequences and `id=` params are emitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct HyperlinkRoute {
    pub(super) emit_osc8: bool,
    pub(super) emit_id: bool,
}

impl HyperlinkRoute {
    pub(super) fn detect() -> Self {
        detect_route_from_env(|key| std::env::var(key).ok())
    }
}

pub(super) fn detect_route_from_env(get: impl Fn(&str) -> Option<String>) -> HyperlinkRoute {
    let is_truthy = |key: &str| {
        get(key).is_some_and(|val| {
            matches!(
                val.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
    };
    let is_falsy = |key: &str| {
        get(key).is_some_and(|val| {
            matches!(
                val.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "no" | "off"
            )
        })
    };
    let has_nonempty = |key: &str| get(key).is_some_and(|val| !val.trim().is_empty());

    if is_truthy("NO_HYPERLINKS") || is_falsy("PEER_HYPERLINKS") {
        return HyperlinkRoute {
            emit_osc8: false,
            emit_id: false,
        };
    }

    if is_truthy("PEER_HYPERLINKS") || is_truthy("FORCE_HYPERLINKS") {
        return HyperlinkRoute {
            emit_osc8: true,
            emit_id: true,
        };
    }

    let term_program = get("TERM_PROGRAM").unwrap_or_default();
    let term_program_lower = term_program.trim().to_ascii_lowercase();
    let term = get("TERM").unwrap_or_default();
    let term_lower = term.trim().to_ascii_lowercase();

    // Terminal.app does not support OSC 8 and can corrupt output on APC/OSC sequences.
    if term_program_lower == "apple_terminal" || term_lower == "dumb" {
        return HyperlinkRoute {
            emit_osc8: false,
            emit_id: false,
        };
    }

    // Legacy GNU Screen without tmux passes through poorly.
    if has_nonempty("STY") && !has_nonempty("TMUX") {
        return HyperlinkRoute {
            emit_osc8: false,
            emit_id: false,
        };
    }

    if ["linux", "vt100", "vt220", "cons", "ansi"]
        .iter()
        .any(|prefix| term_lower.starts_with(prefix))
    {
        return HyperlinkRoute {
            emit_osc8: false,
            emit_id: false,
        };
    }

    let colorterm_truecolor = get("COLORTERM").is_some_and(|val| {
        matches!(
            val.trim().to_ascii_lowercase().as_str(),
            "truecolor" | "24bit"
        )
    });

    let known_env_marker = [
        "GHOSTTY_RESOURCES_DIR",
        "GHOSTTY_BIN_DIR",
        "KITTY_WINDOW_ID",
        "WEZTERM_EXECUTABLE",
        "WEZTERM_PANE",
        "ITERM_SESSION_ID",
        "WT_SESSION",
        "VTE_VERSION",
        "KONSOLE_VERSION",
        "ALACRITTY_SOCKET",
        "ALACRITTY_WINDOW_ID",
        "CMUX_WORKSPACE_ID",
        "CMUX_SURFACE_ID",
        "WARP_IS_LOCAL_SHELL_SESSION",
        "ZED_TERM",
    ]
    .iter()
    .any(|key| has_nonempty(key));

    let modern_term_name = [
        "ghostty",
        "kitty",
        "wezterm",
        "alacritty",
        "foot",
        "rio",
        "contour",
        "tmux",
    ]
    .iter()
    .any(|needle| term_lower.contains(needle));

    if !term_program_lower.is_empty() || colorterm_truecolor || known_env_marker || modern_term_name
    {
        HyperlinkRoute {
            emit_osc8: true,
            emit_id: true,
        }
    } else {
        // Isolated headless PTY harnesses (e.g. plain TERM=xterm-256color) stay CSI-clean.
        HyperlinkRoute {
            emit_osc8: false,
            emit_id: false,
        }
    }
}

fn strip_line_col_suffix(s: &str) -> &str {
    let Some((head, tail)) = s.rsplit_once(':') else {
        return s;
    };
    if tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit()) {
        return s;
    }
    if let Some((head2, line_part)) = head.rsplit_once(':')
        && !line_part.is_empty()
        && line_part.bytes().all(|b| b.is_ascii_digit())
        && !head2.is_empty()
    {
        return head2;
    }
    if head.is_empty() { s } else { head }
}

fn path_to_file_uri(path: &Path) -> Option<String> {
    let raw = path.to_str()?;
    let normalized = if raw.starts_with('/') {
        std::borrow::Cow::Borrowed(raw)
    } else {
        let stripped = raw.strip_prefix(r"\\?\").unwrap_or(raw);
        let bytes = stripped.as_bytes();
        if bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/')
        {
            std::borrow::Cow::Owned(format!("/{}", stripped.replace('\\', "/")))
        } else {
            return None;
        }
    };
    let mut uri = String::with_capacity(7 + normalized.len() + 16);
    uri.push_str("file://");
    let bytes = normalized.as_bytes();
    for (idx, &b) in bytes.iter().enumerate() {
        let is_windows_drive_colon =
            idx == 2 && b == b':' && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic();
        let keep = is_windows_drive_colon
            || matches!(
                b,
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/'
            );
        if keep {
            uri.push(char::from(b));
        } else {
            const HEX: &[u8; 16] = b"0123456789ABCDEF";
            uri.push('%');
            uri.push(char::from(HEX[usize::from(b >> 4)]));
            uri.push(char::from(HEX[usize::from(b & 0x0f)]));
        }
    }
    if uri.len() > MAX_OSC8_URI_BYTES || uri.chars().any(char::is_control) {
        return None;
    }
    Some(uri)
}

fn resolve_relative_in_workspace(rel: &str, workspace: &Path) -> Option<PathBuf> {
    let clean = rel.trim_start_matches("./");
    if clean.is_empty() {
        return None;
    }
    let direct = workspace.join(clean);
    if direct.exists() {
        return Some(fs::canonicalize(&direct).unwrap_or(direct));
    }

    // Also inspect 1-level sub-repos inside multi-repo workspaces (e.g. `Peer-Knowledge/...` or `crates/...`).
    let entries = fs::read_dir(workspace).ok()?;
    let mut found: Option<PathBuf> = None;
    for entry in entries.flatten().take(MAX_WORKSPACE_CHILD_SCAN) {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') || matches!(name_str.as_ref(), "target" | "node_modules") {
            continue;
        }
        let Ok(ftype) = entry.file_type() else {
            continue;
        };
        if !ftype.is_dir() {
            continue;
        }
        let candidate = entry.path().join(clean);
        if candidate.exists() {
            let resolved = fs::canonicalize(&candidate).unwrap_or(candidate);
            if found.is_some() {
                // Ambiguous across multiple sub-workspaces: avoid guessing.
                return None;
            }
            found = Some(resolved);
        }
    }
    found
}

/// Convert a parsed link target (URL or local path) into a validated OSC 8 URI.
pub(super) fn resolve_osc8_uri(
    target: &str,
    workspace: &Path,
    home: Option<&Path>,
) -> Option<String> {
    let trimmed = target.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_OSC8_URI_BYTES
        || trimmed.chars().any(char::is_control)
    {
        return None;
    }

    let raw_bytes = trimmed.as_bytes();
    for prefix in [b"https://".as_slice(), b"http://", b"mailto:"] {
        if raw_bytes.len() > prefix.len() && raw_bytes[..prefix.len()].eq_ignore_ascii_case(prefix)
        {
            if trimmed.chars().any(char::is_whitespace) {
                return None;
            }
            return Some(trimmed.to_owned());
        }
    }

    if raw_bytes.len() > 7 && raw_bytes[..7].eq_ignore_ascii_case(b"file://") {
        let rest = &trimmed[7..];
        if rest.is_empty() || trimmed.chars().any(|c| c.is_whitespace() && c != ' ') {
            return None;
        }
        if trimmed.contains(' ') {
            return Some(trimmed.replace(' ', "%20"));
        }
        return Some(trimmed.to_owned());
    }

    let path_str = strip_line_col_suffix(trimmed);
    if path_str.is_empty() || path_str.contains("://") {
        return None;
    }

    if let Some(rel) = path_str.strip_prefix("~/") {
        let home_dir = home?;
        let joined = home_dir.join(rel);
        let resolved = if joined.exists() {
            fs::canonicalize(&joined).unwrap_or(joined)
        } else {
            joined
        };
        return path_to_file_uri(&resolved);
    }

    if path_str.starts_with('/') {
        let p = Path::new(path_str);
        let resolved = if p.exists() {
            fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
        } else {
            p.to_path_buf()
        };
        return path_to_file_uri(&resolved);
    }

    let resolved = resolve_relative_in_workspace(path_str, workspace)?;
    path_to_file_uri(&resolved)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PaintedLink {
    row: u16,
    col_start: u16,
    col_end: u16,
    uri: String,
    id: u32,
    cells_hash: u64,
}

impl PaintedLink {
    fn overlaps_row_range(&self, other: &Self) -> bool {
        self.row == other.row && self.col_start < other.col_end && other.col_start < self.col_end
    }
}

fn fnv1a_update(hash: &mut u64, bytes: &[u8]) {
    for &b in bytes {
        *hash ^= u64::from(b);
        *hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
}

fn hash_color(hash: &mut u64, color: Color) {
    match color {
        Color::Reset => fnv1a_update(hash, &[0]),
        Color::Black => fnv1a_update(hash, &[1]),
        Color::Red => fnv1a_update(hash, &[2]),
        Color::Green => fnv1a_update(hash, &[3]),
        Color::Yellow => fnv1a_update(hash, &[4]),
        Color::Blue => fnv1a_update(hash, &[5]),
        Color::Magenta => fnv1a_update(hash, &[6]),
        Color::Cyan => fnv1a_update(hash, &[7]),
        Color::Gray => fnv1a_update(hash, &[8]),
        Color::DarkGray => fnv1a_update(hash, &[9]),
        Color::LightRed => fnv1a_update(hash, &[10]),
        Color::LightGreen => fnv1a_update(hash, &[11]),
        Color::LightYellow => fnv1a_update(hash, &[12]),
        Color::LightBlue => fnv1a_update(hash, &[13]),
        Color::LightMagenta => fnv1a_update(hash, &[14]),
        Color::LightCyan => fnv1a_update(hash, &[15]),
        Color::White => fnv1a_update(hash, &[16]),
        Color::Indexed(i) => fnv1a_update(hash, &[17, i]),
        Color::Rgb(r, g, b) => fnv1a_update(hash, &[18, r, g, b]),
    }
}

fn hash_buffer_span(buffer: &Buffer, row: u16, col_start: u16, col_end: u16) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for col in col_start..col_end {
        let cell = &buffer[(col, row)];
        fnv1a_update(&mut hash, cell.symbol().as_bytes());
        hash_color(&mut hash, cell.fg);
        hash_color(&mut hash, cell.bg);
        fnv1a_update(&mut hash, &cell.modifier.bits().to_le_bytes());
        let skip_flag = u8::from(cell.diff_option == CellDiffOption::Skip);
        fnv1a_update(&mut hash, &[skip_flag]);
    }
    hash
}

fn write_fg_sgr(out: &mut Vec<u8>, color: Color) {
    use std::io::Write as _;
    match color {
        Color::Reset => out.extend_from_slice(b";39"),
        Color::Black => out.extend_from_slice(b";30"),
        Color::Red => out.extend_from_slice(b";31"),
        Color::Green => out.extend_from_slice(b";32"),
        Color::Yellow => out.extend_from_slice(b";33"),
        Color::Blue => out.extend_from_slice(b";34"),
        Color::Magenta => out.extend_from_slice(b";35"),
        Color::Cyan => out.extend_from_slice(b";36"),
        Color::Gray => out.extend_from_slice(b";37"),
        Color::DarkGray => out.extend_from_slice(b";90"),
        Color::LightRed => out.extend_from_slice(b";91"),
        Color::LightGreen => out.extend_from_slice(b";92"),
        Color::LightYellow => out.extend_from_slice(b";93"),
        Color::LightBlue => out.extend_from_slice(b";94"),
        Color::LightMagenta => out.extend_from_slice(b";95"),
        Color::LightCyan => out.extend_from_slice(b";96"),
        Color::White => out.extend_from_slice(b";97"),
        Color::Indexed(i) => {
            let _ = write!(out, ";38;5;{i}");
        }
        Color::Rgb(r, g, b) => {
            let _ = write!(out, ";38;2;{r};{g};{b}");
        }
    }
}

fn write_bg_sgr(out: &mut Vec<u8>, color: Color) {
    use std::io::Write as _;
    match color {
        Color::Reset => out.extend_from_slice(b";49"),
        Color::Black => out.extend_from_slice(b";40"),
        Color::Red => out.extend_from_slice(b";41"),
        Color::Green => out.extend_from_slice(b";42"),
        Color::Yellow => out.extend_from_slice(b";43"),
        Color::Blue => out.extend_from_slice(b";44"),
        Color::Magenta => out.extend_from_slice(b";45"),
        Color::Cyan => out.extend_from_slice(b";46"),
        Color::Gray => out.extend_from_slice(b";47"),
        Color::DarkGray => out.extend_from_slice(b";100"),
        Color::LightRed => out.extend_from_slice(b";101"),
        Color::LightGreen => out.extend_from_slice(b";102"),
        Color::LightYellow => out.extend_from_slice(b";103"),
        Color::LightBlue => out.extend_from_slice(b";104"),
        Color::LightMagenta => out.extend_from_slice(b";105"),
        Color::LightCyan => out.extend_from_slice(b";106"),
        Color::White => out.extend_from_slice(b";107"),
        Color::Indexed(i) => {
            let _ = write!(out, ";48;5;{i}");
        }
        Color::Rgb(r, g, b) => {
            let _ = write!(out, ";48;2;{r};{g};{b}");
        }
    }
}

fn write_cell_style_sgr(out: &mut Vec<u8>, cell: &Cell) {
    out.extend_from_slice(b"\x1b[0");
    if cell.modifier.contains(Modifier::BOLD) {
        out.extend_from_slice(b";1");
    }
    if cell.modifier.contains(Modifier::DIM) {
        out.extend_from_slice(b";2");
    }
    if cell.modifier.contains(Modifier::ITALIC) {
        out.extend_from_slice(b";3");
    }
    if cell.modifier.contains(Modifier::UNDERLINED) {
        out.extend_from_slice(b";4");
    }
    if cell.modifier.contains(Modifier::SLOW_BLINK) {
        out.extend_from_slice(b";5");
    }
    if cell.modifier.contains(Modifier::RAPID_BLINK) {
        out.extend_from_slice(b";6");
    }
    if cell.modifier.contains(Modifier::REVERSED) {
        out.extend_from_slice(b";7");
    }
    if cell.modifier.contains(Modifier::HIDDEN) {
        out.extend_from_slice(b";8");
    }
    if cell.modifier.contains(Modifier::CROSSED_OUT) {
        out.extend_from_slice(b";9");
    }
    write_fg_sgr(out, cell.fg);
    write_bg_sgr(out, cell.bg);
    out.push(b'm');
}

fn write_buffer_cells(
    out: &mut Vec<u8>,
    buffer: &Buffer,
    area: Rect,
    row: u16,
    col_start: u16,
    col_end: u16,
) {
    let max_col = col_end.min(area.right());
    let mut col = col_start.max(area.left());
    let mut last_style: Option<(Color, Color, Modifier)> = None;

    while col < max_col {
        let cell = &buffer[(col, row)];
        if cell.diff_option == CellDiffOption::Skip {
            col += 1;
            continue;
        }
        let sym = cell.symbol();
        let sym_w = peer_tui::display_width(sym).max(1) as u16;
        if col.saturating_add(sym_w) > max_col && col > col_start {
            break;
        }
        let cur_style = (cell.fg, cell.bg, cell.modifier);
        if last_style != Some(cur_style) {
            write_cell_style_sgr(out, cell);
            last_style = Some(cur_style);
        }
        out.extend_from_slice(sym.as_bytes());
        col = col.saturating_add(sym_w);
    }
}

/// Tracks rendered screen hyperlinks and emits bounded OSC 8 diff overlays after Ratatui draws.
pub(super) struct HyperlinkOverlayState {
    route: HyperlinkRoute,
    last_area: Rect,
    last_workspace: PathBuf,
    active: Vec<PaintedLink>,
    uri_cache: HashMap<String, Option<String>>,
}

impl HyperlinkOverlayState {
    pub(super) fn detect() -> Self {
        Self::with_route(HyperlinkRoute::detect())
    }

    pub(super) fn with_route(route: HyperlinkRoute) -> Self {
        Self {
            route,
            last_area: Rect::default(),
            last_workspace: PathBuf::new(),
            active: Vec::new(),
            uri_cache: HashMap::new(),
        }
    }

    fn resolve_cached(
        &mut self,
        target: &str,
        workspace: &Path,
        home: Option<&Path>,
    ) -> Option<String> {
        if self.last_workspace != workspace {
            self.last_workspace = workspace.to_path_buf();
            self.uri_cache.clear();
        }
        if let Some(cached) = self.uri_cache.get(target) {
            return cached.clone();
        }
        let resolved = resolve_osc8_uri(target, workspace, home);
        if self.uri_cache.len() >= MAX_URI_CACHE_ENTRIES {
            self.uri_cache.clear();
        }
        self.uri_cache.insert(target.to_owned(), resolved.clone());
        resolved
    }

    pub(super) fn apply<W: Write>(
        &mut self,
        buffer: &Buffer,
        area: Rect,
        raw_links: &[ScreenHyperlink],
        workspace: &Path,
        out: &mut W,
    ) -> io::Result<bool> {
        if !self.route.emit_osc8 {
            return Ok(false);
        }
        let home = std::env::var_os("HOME").map(PathBuf::from);
        self.apply_with_home(buffer, area, raw_links, workspace, home.as_deref(), out)
    }

    pub(super) fn apply_with_home<W: Write>(
        &mut self,
        buffer: &Buffer,
        area: Rect,
        raw_links: &[ScreenHyperlink],
        workspace: &Path,
        home: Option<&Path>,
        out: &mut W,
    ) -> io::Result<bool> {
        if !self.route.emit_osc8 {
            return Ok(false);
        }
        if self.last_area != area {
            self.active.clear();
            self.last_area = area;
        }
        if area.width == 0 || area.height == 0 {
            self.active.clear();
            return Ok(false);
        }

        let mut next = Vec::with_capacity(raw_links.len());
        for link in raw_links {
            if link.row < area.top() || link.row >= area.bottom() {
                continue;
            }
            let cs = link.col_start.max(area.left());
            let ce = link.col_end.min(area.right());
            if cs >= ce {
                continue;
            }
            let Some(uri) = self.resolve_cached(&link.target, workspace, home) else {
                continue;
            };
            let cells_hash = hash_buffer_span(buffer, link.row, cs, ce);
            next.push(PaintedLink {
                row: link.row,
                col_start: cs,
                col_end: ce,
                uri,
                id: link.id,
                cells_hash,
            });
        }

        if next == self.active {
            return Ok(false);
        }

        let stale: Vec<&PaintedLink> = self
            .active
            .iter()
            .filter(|old| !next.contains(old))
            .collect();

        let to_paint: Vec<&PaintedLink> = next
            .iter()
            .filter(|link| {
                !self.active.contains(link) || stale.iter().any(|old| link.overlaps_row_range(old))
            })
            .collect();

        if stale.is_empty() && to_paint.is_empty() {
            self.active = next;
            return Ok(false);
        }

        let mut buf: Vec<u8> = Vec::with_capacity((stale.len() + to_paint.len()) * 96 + 16);
        buf.extend_from_slice(b"\x1b7");

        for old in &stale {
            let _ = write!(
                buf,
                "\x1b[{};{}H\x1b]8;;\x1b\\",
                old.row + 1,
                old.col_start + 1
            );
            write_buffer_cells(&mut buf, buffer, area, old.row, old.col_start, old.col_end);
        }

        for link in &to_paint {
            let _ = write!(buf, "\x1b[{};{}H", link.row + 1, link.col_start + 1);
            if self.route.emit_id {
                let _ = write!(buf, "\x1b]8;id=p{};{}\x1b\\", link.id, link.uri);
            } else {
                let _ = write!(buf, "\x1b]8;;{}\x1b\\", link.uri);
            }
            write_buffer_cells(
                &mut buf,
                buffer,
                area,
                link.row,
                link.col_start,
                link.col_end,
            );
            buf.extend_from_slice(b"\x1b]8;;\x1b\\");
        }

        buf.extend_from_slice(b"\x1b[0m\x1b8");
        out.write_all(&buf)?;
        out.flush()?;

        let wrote_links = !to_paint.is_empty();
        self.active = next;
        Ok(wrote_links)
    }

    pub(super) fn clear_active<W: Write>(
        &mut self,
        buffer: &Buffer,
        area: Rect,
        out: &mut W,
    ) -> io::Result<()> {
        if self.active.is_empty() {
            return Ok(());
        }
        let _ = self.apply_with_home(buffer, area, &[], Path::new(""), None, out)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::Style;
    use tempfile::tempdir;

    #[test]
    fn detect_route_respects_apple_terminal_overrides_and_modern_terminals() {
        let env_from = |pairs: &[(&str, &str)]| {
            let map: HashMap<String, String> = pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect();
            detect_route_from_env(move |k| map.get(k).cloned())
        };

        // Hostile / unsupported terminals
        assert_eq!(
            env_from(&[
                ("TERM_PROGRAM", "Apple_Terminal"),
                ("TERM", "xterm-256color")
            ]),
            HyperlinkRoute {
                emit_osc8: false,
                emit_id: false
            }
        );
        assert_eq!(
            env_from(&[("STY", "1234.pts"), ("TERM", "screen-256color")]),
            HyperlinkRoute {
                emit_osc8: false,
                emit_id: false
            }
        );
        assert_eq!(
            env_from(&[("TERM_PROGRAM", "ghostty"), ("NO_HYPERLINKS", "1")]),
            HyperlinkRoute {
                emit_osc8: false,
                emit_id: false
            }
        );
        assert_eq!(
            env_from(&[("TERM_PROGRAM", "ghostty"), ("PEER_HYPERLINKS", "0")]),
            HyperlinkRoute {
                emit_osc8: false,
                emit_id: false
            }
        );

        // Isolated headless PTY harnesses with only TERM=xterm-256color stay CSI-clean.
        assert_eq!(
            env_from(&[("TERM", "xterm-256color")]),
            HyperlinkRoute {
                emit_osc8: false,
                emit_id: false
            }
        );

        // Modern macOS / Linux terminals auto-enable with id= support
        for pairs in [
            vec![("TERM_PROGRAM", "ghostty")],
            vec![("TERM_PROGRAM", "iTerm.app")],
            vec![("TERM_PROGRAM", "WarpTerminal")],
            vec![("TERM_PROGRAM", "cmux")],
            vec![("TERM_PROGRAM", "Orca"), ("COLORTERM", "truecolor")],
            vec![("GHOSTTY_RESOURCES_DIR", "/Applications/Ghostty.app")],
            vec![("KITTY_WINDOW_ID", "1")],
            vec![("TERM", "xterm-ghostty")],
            vec![("TERM", "dumb"), ("PEER_HYPERLINKS", "1")],
        ] {
            assert_eq!(
                env_from(&pairs),
                HyperlinkRoute {
                    emit_osc8: true,
                    emit_id: true
                },
                "expected OSC 8 enabled for {pairs:?}"
            );
        }
    }

    #[test]
    fn resolve_osc8_uri_handles_urls_paths_line_suffixes_and_rejects_injections() {
        let dir = tempdir().unwrap();
        let ws = fs::canonicalize(dir.path()).unwrap();
        let nested = ws.join("crates/peer-tui/src");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("table.rs"), b"// table\n").unwrap();

        let multi = ws.join("Peer-Knowledge/knowledge/decisions");
        fs::create_dir_all(&multi).unwrap();
        fs::write(multi.join("133-architecture.md"), b"# 133\n").unwrap();

        let home_dir = ws.join("home");
        fs::create_dir_all(&home_dir).unwrap();
        fs::write(home_dir.join("notes.md"), b"hi").unwrap();

        // URLs pass cleanly
        assert_eq!(
            resolve_osc8_uri("https://example.com/a(b)?x=1", &ws, Some(&home_dir)).as_deref(),
            Some("https://example.com/a(b)?x=1")
        );
        assert_eq!(
            resolve_osc8_uri("file:///tmp/my%20file.md", &ws, Some(&home_dir)).as_deref(),
            Some("file:///tmp/my%20file.md")
        );

        // Absolute path with spaces, `#`, and `:line:col` suffix encodes to valid `file:///` URI
        assert_eq!(
            resolve_osc8_uri("/abs/my dir/file #1.md:42:3", &ws, Some(&home_dir)).as_deref(),
            Some("file:///abs/my%20dir/file%20%231.md")
        );

        // Home path expands `~/`
        let expected_home = path_to_file_uri(&home_dir.join("notes.md")).unwrap();
        assert!(expected_home.starts_with("file:///") && expected_home.ends_with("/notes.md"));
        assert_eq!(
            resolve_osc8_uri("~/notes.md:10", &ws, Some(&home_dir)).as_deref(),
            Some(expected_home.as_str())
        );

        // Workspace-relative path + 1-level child repo path with `:line` suffix both resolve
        let expected_rel = path_to_file_uri(&ws.join("crates/peer-tui/src/table.rs")).unwrap();
        assert!(expected_rel.ends_with("/crates/peer-tui/src/table.rs"));
        assert_eq!(
            resolve_osc8_uri("crates/peer-tui/src/table.rs:640", &ws, Some(&home_dir)).as_deref(),
            Some(expected_rel.as_str())
        );
        let expected_child =
            path_to_file_uri(&ws.join("Peer-Knowledge/knowledge/decisions/133-architecture.md"))
                .unwrap();
        assert!(
            expected_child.ends_with("/Peer-Knowledge/knowledge/decisions/133-architecture.md")
        );
        assert_eq!(
            resolve_osc8_uri(
                "knowledge/decisions/133-architecture.md",
                &ws,
                Some(&home_dir)
            )
            .as_deref(),
            Some(expected_child.as_str())
        );

        // Nonexistent relative path returns None (never emits dead links)
        assert_eq!(
            resolve_osc8_uri("does/not/exist.rs", &ws, Some(&home_dir)),
            None
        );

        // Control chars / ESC / BEL / unsafe schemes are rejected
        assert_eq!(
            resolve_osc8_uri("https://evil.test/\x1b]8;;", &ws, Some(&home_dir)),
            None
        );
        assert_eq!(
            resolve_osc8_uri("/tmp/foo\x07bar.md", &ws, Some(&home_dir)),
            None
        );
        assert_eq!(
            resolve_osc8_uri("javascript:alert(1)", &ws, Some(&home_dir)),
            None
        );
    }

    #[test]
    fn hyperlink_overlay_emits_osc8_diffs_clears_stale_and_handles_cjk() {
        let dir = tempdir().unwrap();
        let ws = dir.path();
        let area = Rect::new(0, 0, 24, 3);
        let mut buf = Buffer::empty(area);
        let link_style = Style::new()
            .fg(Color::Cyan)
            .add_modifier(Modifier::UNDERLINED);
        buf.set_string(2, 1, "查看文档", link_style);

        let links = vec![ScreenHyperlink {
            row: 1,
            col_start: 2,
            col_end: 10,
            target: "/tmp/架构 doc.md".to_owned(),
            id: 77,
        }];

        let mut state = HyperlinkOverlayState::with_route(HyperlinkRoute {
            emit_osc8: true,
            emit_id: true,
        });

        // First frame writes atomic DECSC + CUP + OSC 8 + SGR + CJK text (no spaces!) + close + DECRC
        let mut out1 = Vec::new();
        let active = state
            .apply_with_home(&buf, area, &links, ws, None, &mut out1)
            .unwrap();
        assert!(active);
        let s1 = String::from_utf8(out1).unwrap();
        assert!(s1.starts_with("\x1b7"));
        assert!(s1.ends_with("\x1b[0m\x1b8"));
        assert!(
            s1.contains("\x1b[2;3H\x1b]8;id=p77;file:///tmp/%E6%9E%B6%E6%9E%84%20doc.md\x1b\\")
        );
        assert!(s1.contains("查看文档\x1b]8;;\x1b\\"));

        // Identical second frame emits zero bytes
        let mut out2 = Vec::new();
        let active2 = state
            .apply_with_home(&buf, area, &links, ws, None, &mut out2)
            .unwrap();
        assert!(!active2);
        assert!(out2.is_empty());

        // Removing the link clears the OSC 8 span and repaints plain cells
        buf.set_string(2, 1, "普通文本", Style::new().fg(Color::White));
        let mut out3 = Vec::new();
        let active3 = state
            .apply_with_home(&buf, area, &[], ws, None, &mut out3)
            .unwrap();
        assert!(!active3);
        let s3 = String::from_utf8(out3).unwrap();
        assert!(s3.contains("\x1b[2;3H\x1b]8;;\x1b\\"));
        assert!(s3.contains("普通文本"));
    }
}
