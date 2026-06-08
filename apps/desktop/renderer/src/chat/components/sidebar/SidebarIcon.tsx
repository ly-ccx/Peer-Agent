export type SidebarIconName =
  | 'account'
  | 'agent'
  | 'automation'
  | 'channel'
  | 'chevron'
  | 'logout'
  | 'delete'
  | 'developer'
  | 'new'
  | 'pin'
  | 'plugins'
  | 'search'
  | 'settings'
  | 'usage';

export function SidebarIcon({ name }: { readonly name: SidebarIconName }) {
  if (name === 'new') {
    return (
      <svg className="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 5v14M5 12h14" />
      </svg>
    );
  }
  if (name === 'search') {
    return (
      <svg className="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="10.5" cy="10.5" r="5.5" />
        <path d="m15 15 4 4" />
      </svg>
    );
  }
  if (name === 'plugins') {
    return (
      <svg className="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="2.5" />
        <circle cx="16" cy="8" r="2.5" />
        <circle cx="8" cy="16" r="2.5" />
        <circle cx="16" cy="16" r="2.5" />
      </svg>
    );
  }
  if (name === 'agent') {
    return (
      <svg className="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="9" cy="7" r="4" />
        <path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
        <circle cx="19" cy="11" r="2" />
        <path d="M19 8v1M19 13v1" />
      </svg>
    );
  }
  if (name === 'automation') {
    return (
      <svg className="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="7" />
        <path d="M12 8v4l3 2" />
      </svg>
    );
  }
  if (name === 'settings') {
    return (
      <svg className="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    );
  }
  if (name === 'developer') {
    return (
      <svg className="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M8 8 4 12l4 4" />
        <path d="m16 8 4 4-4 4" />
        <path d="m14 5-4 14" />
      </svg>
    );
  }
  if (name === 'account') {
    return (
      <svg className="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="8" r="3.2" />
        <path d="M5.5 19a6.7 6.7 0 0 1 13 0" />
      </svg>
    );
  }
  if (name === 'usage') {
    return (
      <svg className="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M5 15a7 7 0 1 1 14 0" />
        <path d="M12 15l4-4" />
        <path d="M4 19h16" />
      </svg>
    );
  }
  if (name === 'logout') {
    return (
      <svg className="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M10 6H6v12h4" />
        <path d="M13 12h7M17 8l4 4-4 4" />
      </svg>
    );
  }
  if (name === 'pin') {
    return (
      <svg className="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 4v6l-2 4h10l-2-4V4" />
        <path d="M12 14v7" />
        <path d="M8 4h8" />
      </svg>
    );
  }
  if (name === 'delete') {
    return (
      <svg className="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 7h16" />
        <path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" />
        <path d="M9 7V4h6v3" />
      </svg>
    );
  }
  if (name === 'chevron') {
    return (
      <svg className="sidebar-icon sidebar-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="m8 10 4 4 4-4" />
      </svg>
    );
  }
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16" />
    </svg>
  );
}
