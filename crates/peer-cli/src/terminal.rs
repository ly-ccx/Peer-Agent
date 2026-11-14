use crossterm::{
    cursor::{Hide, Show},
    event::{
        self, DisableBracketedPaste, DisableFocusChange, EnableBracketedPaste, EnableFocusChange,
    },
    execute,
    terminal::{self, EnterAlternateScreen, LeaveAlternateScreen},
};
use peer_tui::{Composer, Effect, action_for_event};
use ratatui::{Terminal, backend::CrosstermBackend};
use std::{
    io::{self, Stdout},
    sync::{
        Arc, Once,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

static TERMINAL_ACTIVE: AtomicBool = AtomicBool::new(false);
static PANIC_HOOK: Once = Once::new();
const MAX_TERMINAL_CELLS: u32 = 200_000;

pub struct TerminalGuard {
    terminal: Terminal<CrosstermBackend<Stdout>>,
}

fn restore() {
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
            Ok(Self { terminal })
        })();
        if result.is_err() {
            restore();
        }
        result
    }

    pub fn draw(&mut self, composer: &Composer) -> io::Result<()> {
        check_size()?;
        self.terminal
            .draw(|frame| peer_tui::render(frame, composer))?;
        Ok(())
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore();
    }
}

pub fn run() -> io::Result<()> {
    let stop = Arc::new(AtomicBool::new(false));
    let mut signals = Vec::new();
    for signal in [
        signal_hook::consts::SIGTERM,
        signal_hook::consts::SIGHUP,
        signal_hook::consts::SIGINT,
    ] {
        signals.push(signal_hook::flag::register(signal, stop.clone())?);
    }
    let result = run_loop(stop);
    for signal in signals {
        signal_hook::low_level::unregister(signal);
    }
    result
}

fn run_loop(stop: Arc<AtomicBool>) -> io::Result<()> {
    let mut terminal = TerminalGuard::enter()?;
    let mut composer = Composer::default();
    terminal.draw(&composer)?;
    while !stop.load(Ordering::Relaxed) {
        // Exactly one input owner; no EventStream, background reader or busy redraw loop.
        if !event::poll(Duration::from_millis(100))? {
            continue;
        }
        let Some(action) = action_for_event(event::read()?) else {
            continue;
        };
        match composer.apply(action) {
            Effect::Quit => break,
            Effect::Redraw => terminal.draw(&composer)?,
            Effect::None => {}
        }
    }
    Ok(())
}
