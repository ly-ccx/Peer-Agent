export interface ProcessExpansionState {
  readonly expanded: boolean;
  readonly isActive: boolean;
  readonly userOverrodeActiveExpansion: boolean;
}

export function createProcessExpansionState(isActive: boolean): ProcessExpansionState {
  return {
    expanded: isActive,
    isActive,
    userOverrodeActiveExpansion: false,
  };
}

export function updateProcessActivity(
  state: ProcessExpansionState,
  isActive: boolean,
): ProcessExpansionState {
  if (state.isActive === isActive) return state;

  if (!isActive) {
    return {
      expanded: false,
      isActive,
      userOverrodeActiveExpansion: state.userOverrodeActiveExpansion,
    };
  }

  return {
    expanded: state.userOverrodeActiveExpansion ? state.expanded : true,
    isActive,
    userOverrodeActiveExpansion: state.userOverrodeActiveExpansion,
  };
}

export function toggleProcessExpansion(state: ProcessExpansionState): ProcessExpansionState {
  return {
    ...state,
    expanded: !state.expanded,
    userOverrodeActiveExpansion: state.isActive
      ? state.expanded
      : state.userOverrodeActiveExpansion,
  };
}
