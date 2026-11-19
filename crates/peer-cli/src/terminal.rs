use crossterm::{
    cursor::{Hide, Show},
    event::{DisableBracketedPaste, DisableFocusChange, EnableBracketedPaste, EnableFocusChange},
    execute,
    terminal::{self, EnterAlternateScreen, LeaveAlternateScreen},
};
use peer_protocol::CliExit;
use peer_tui::{Composer, ScreenHyperlink};
use ratatui::{Terminal, backend::CrosstermBackend};
use std::{
    io::{self, Stdout, Write as _},
    path::{Path, PathBuf},
    sync::{
        Once,
        atomic::{AtomicBool, Ordering},
    },
};
mod bot_shell;
mod capability_store;
mod classic;
mod hyperlinks;
mod model_picker_adapter;
mod resumed;
mod theme_store;
pub(crate) use resumed::resume;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InteractiveMode {
    Auto,
    Bots,
    Classic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ShellOutcome {
    Quit,
    SwitchToClassic,
    SwitchToBots,
}

static TERMINAL_ACTIVE: AtomicBool = AtomicBool::new(false);
static OSC8_ACTIVE: AtomicBool = AtomicBool::new(false);
static PANIC_HOOK: Once = Once::new();
const MAX_TERMINAL_CELLS: u32 = 200_000;

pub struct TerminalGuard {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    hyperlink_overlay: hyperlinks::HyperlinkOverlayState,
}

fn restore() {
    if OSC8_ACTIVE.swap(false, Ordering::SeqCst) {
        let mut stdout = io::stdout();
        let _ = stdout.write_all(b"\x1b]8;;\x1b\\\x1b[0m");
        let _ = stdout.flush();
    }
    if TERMINAL_ACTIVE.swap(false, Ordering::SeqCst) {
        let _ = terminal::disable_raw_mode();
        let _ = execute!(
            io::stdout(),
            DisableBracketedPaste,
            DisableFocusChange,
            Show,
            LeaveAlternateScreen
        );
    }
}

fn check_size() -> io::Result<()> {
    let (width, height) = terminal::size()?;
    if u32::from(width) * u32::from(height) > MAX_TERMINAL_CELLS {
        return Err(io::Error::other(
            "terminal size exceeds the bounded render budget",
        ));
    }
    Ok(())
}

impl TerminalGuard {
    pub fn enter() -> io::Result<Self> {
        check_size()?;
        TERMINAL_ACTIVE
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| io::Error::other("terminal already has an owner"))?;
        if let Err(error) = terminal::enable_raw_mode() {
            TERMINAL_ACTIVE.store(false, Ordering::SeqCst);
            return Err(error);
        }
        PANIC_HOOK.call_once(|| {
            let hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                restore();
                hook(info);
            }));
        });
        let result = (|| {
            execute!(
                io::stdout(),
                EnterAlternateScreen,
                EnableBracketedPaste,
                EnableFocusChange,
                Hide
            )?;
            let terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
            Ok(Self {
                terminal,
                hyperlink_overlay: hyperlinks::HyperlinkOverlayState::detect(),
            })
        })();
        if result.is_err() {
            restore();
        }
        result
    }

    pub fn draw(&mut self, composer: &Composer) -> io::Result<()> {
        self.draw_frame(|frame| peer_tui::render(frame, composer))
    }

    fn draw_frame(&mut self, render: impl FnOnce(&mut ratatui::Frame<'_>)) -> io::Result<()> {
        check_size()?;
        let completed = self.terminal.draw(render)?;
        self.hyperlink_overlay
            .clear_active(completed.buffer, completed.area, &mut io::stdout())?;
        Ok(())
    }

    fn draw_frame_with_links(
        &mut self,
        workspace: &Path,
        render: impl FnOnce(&mut ratatui::Frame<'_>, &mut Vec<ScreenHyperlink>),
    ) -> io::Result<()> {
        check_size()?;
        let mut links = Vec::new();
        let completed = self.terminal.draw(|frame| render(frame, &mut links))?;
        let active = self.hyperlink_overlay.apply(
            completed.buffer,
            completed.area,
            &links,
            workspace,
            &mut io::stdout(),
        )?;
        if active {
            OSC8_ACTIVE.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore();
    }
}

pub fn run() -> io::Result<()> {
    run_mode(InteractiveMode::Auto)?;
    Ok(())
}

pub fn run_mode(initial_mode: InteractiveMode) -> io::Result<CliExit> {
    let Some(home) = peer_protocol::data_home() else {
        return Err(io::Error::other("data home unavailable"));
    };
    let workspace = std::env::var_os("PEER_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| std::env::current_dir().ok())
        .ok_or_else(|| io::Error::other("workspace unavailable"))?;

    crate::cancellation::run(|shutdown| async move {
        let mut terminal = TerminalGuard::enter()?;
        let mut current = initial_mode;
        let mut prefs = theme_store::load_preferences(&home);
        loop {
            let outcome = match current {
                InteractiveMode::Classic => {
                    classic::run_classic_shell(
                        home.clone(),
                        workspace.clone(),
                        &mut prefs,
                        &mut terminal,
                        &shutdown,
                    )
                    .await?
                }
                InteractiveMode::Bots => {
                    bot_shell::run_bot_shell(
                        home.clone(),
                        workspace.clone(),
                        true,
                        &mut prefs,
                        &mut terminal,
                        &shutdown,
                    )
                    .await?
                }
                InteractiveMode::Auto => {
                    bot_shell::run_bot_shell(
                        home.clone(),
                        workspace.clone(),
                        false,
                        &mut prefs,
                        &mut terminal,
                        &shutdown,
                    )
                    .await?
                }
            };
            match outcome {
                ShellOutcome::Quit => break,
                ShellOutcome::SwitchToClassic => current = InteractiveMode::Classic,
                ShellOutcome::SwitchToBots => current = InteractiveMode::Bots,
            }
        }
        Ok::<CliExit, io::Error>(CliExit::Ok)
    })?
}
