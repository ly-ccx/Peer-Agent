use peer_cli::terminal::TerminalGuard;

fn main() -> std::io::Result<()> {
    let mut guard = TerminalGuard::enter()?;
    guard.draw(&peer_tui::Composer::default())?;
    match std::env::args().nth(1).as_deref() {
        Some("panic") => panic!("isolated terminal lifecycle fault injection"),
        Some("error") => return Err(std::io::Error::other("isolated terminal lifecycle error")),
        _ => {}
    }
    Ok(())
}
