//! Pure `Ctrl+X` leader-key chord state machine mirroring `apps/tui/src/leader-key.ts`.
//!
//! Strictly pure key state transitions with zero filesystem or process I/O.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct LeaderKeyState {
    armed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaderAction {
    /// Leader was neither armed nor triggered by this key event.
    None,
    /// `Ctrl+X` armed the leader prefix; caller should show shortcut bar.
    Armed,
    /// Pending leader was cancelled (`Esc`, `Ctrl+G`, second `Ctrl+X`, or unknown key).
    Cancelled,
    /// Modifier-only press while armed; stay armed and swallow.
    Consumed,
    /// Resolved chord to a Classic slash command id (`"model"`, `"mode"`, `"permissions"`, `"new"`, `"resume"`).
    Command(&'static str),
    /// Resolved chord to a runtime mode wire name (`"chat"`, `"plan"`, `"goal"`).
    Mode(&'static str),
}

impl LeaderKeyState {
    pub const fn is_armed(self) -> bool {
        self.armed
    }

    pub fn cancel(&mut self) {
        self.armed = false;
    }

    pub fn resolve(&mut self, key: KeyEvent) -> LeaderAction {
        if key.kind == KeyEventKind::Release {
            return LeaderAction::None;
        }
        let is_ctrl_x = key.modifiers.contains(KeyModifiers::CONTROL)
            && !key.modifiers.contains(KeyModifiers::ALT)
            && matches!(key.code, KeyCode::Char('x' | 'X'));

        if !self.armed {
            if is_ctrl_x {
                self.armed = true;
                return LeaderAction::Armed;
            }
            return LeaderAction::None;
        }

        if is_ctrl_x
            || matches!(key.code, KeyCode::Esc)
            || (key.modifiers.contains(KeyModifiers::CONTROL)
                && matches!(key.code, KeyCode::Char('g' | 'G')))
        {
            self.armed = false;
            return LeaderAction::Cancelled;
        }

        if matches!(key.code, KeyCode::Modifier(_)) {
            return LeaderAction::Consumed;
        }

        self.armed = false;
        match key.code {
            KeyCode::Char('m' | 'M') => LeaderAction::Command("model"),
            KeyCode::Char('o' | 'O') => LeaderAction::Command("mode"),
            KeyCode::Char('p' | 'P') => LeaderAction::Command("permissions"),
            KeyCode::Char('n' | 'N') => LeaderAction::Command("new"),
            KeyCode::Char('l' | 'L') => LeaderAction::Command("resume"),
            KeyCode::Char('1') => LeaderAction::Mode("chat"),
            KeyCode::Char('2') => LeaderAction::Mode("plan"),
            KeyCode::Char('3') => LeaderAction::Mode("goal"),
            _ => LeaderAction::Cancelled,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    #[test]
    fn leader_chords_arm_resolve_and_cancel_cleanly() {
        let mut leader = LeaderKeyState::default();
        assert_eq!(
            leader.resolve(key(KeyCode::Char('a'), KeyModifiers::NONE)),
            LeaderAction::None
        );

        assert_eq!(
            leader.resolve(key(KeyCode::Char('x'), KeyModifiers::CONTROL)),
            LeaderAction::Armed
        );
        assert!(leader.is_armed());
        assert_eq!(
            leader.resolve(key(KeyCode::Char('l'), KeyModifiers::NONE)),
            LeaderAction::Command("resume")
        );
        assert!(!leader.is_armed());

        assert_eq!(
            leader.resolve(key(KeyCode::Char('x'), KeyModifiers::CONTROL)),
            LeaderAction::Armed
        );
        assert_eq!(
            leader.resolve(key(KeyCode::Char('2'), KeyModifiers::NONE)),
            LeaderAction::Mode("plan")
        );

        assert_eq!(
            leader.resolve(key(KeyCode::Char('x'), KeyModifiers::CONTROL)),
            LeaderAction::Armed
        );
        assert_eq!(
            leader.resolve(key(KeyCode::Esc, KeyModifiers::NONE)),
            LeaderAction::Cancelled
        );
        assert!(!leader.is_armed());

        // Unknown second key cancels without leaking into composer
        assert_eq!(
            leader.resolve(key(KeyCode::Char('x'), KeyModifiers::CONTROL)),
            LeaderAction::Armed
        );
        assert_eq!(
            leader.resolve(key(KeyCode::Char('z'), KeyModifiers::NONE)),
            LeaderAction::Cancelled
        );
        assert!(!leader.is_armed());
    }
}
