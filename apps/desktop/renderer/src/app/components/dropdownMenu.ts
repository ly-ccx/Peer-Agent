export interface DropdownOption {
  readonly value: string;
  readonly label: string;
  readonly tone?: 'danger';
  readonly group?: string;
  readonly hint?: string;
  /** When set, the option is only listed while this tab is active. Untagged options stay visible on every tab. */
  readonly tab?: string;
}

export interface DropdownTab {
  readonly id: string;
  readonly label: string;
}

export function optionMatchesDropdownQuery(option: DropdownOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [option.label, option.value, option.hint ?? '', option.group ?? '']
    .join('\n')
    .toLowerCase();
  return haystack.includes(q);
}

export function resolveDropdownActiveTab(input: {
  readonly tabs: readonly DropdownTab[] | undefined;
  readonly options: readonly DropdownOption[];
  readonly value: string;
}): string {
  const tabs = input.tabs ?? [];
  if (tabs.length === 0) return '';
  const selected = input.options.find((option) => option.value === input.value);
  if (selected?.tab && tabs.some((tab) => tab.id === selected.tab)) {
    return selected.tab;
  }
  return tabs[0]?.id ?? '';
}

export function filterDropdownOptions(
  options: readonly DropdownOption[],
  query: string,
  tabId?: string,
): DropdownOption[] {
  return options.filter((option) => {
    if (tabId && option.tab && option.tab !== tabId) return false;
    return optionMatchesDropdownQuery(option, query);
  });
}
