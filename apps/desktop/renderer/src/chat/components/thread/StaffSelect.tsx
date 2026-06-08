import { useCallback, useEffect, useRef, useState } from 'react';
import { clientApi } from '../../../clientApi';

interface StaffItem {
  workNo: string;
  nickName?: string;
  name?: string;
}

interface StaffSelectProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
}

export function StaffSelect({ value, onChange, placeholder }: StaffSelectProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StaffItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const staffCacheRef = useRef<Map<string, StaffItem>>(new Map());

  const selectedIds = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const raw: any = await clientApi.searchStaff({ query: q.trim() });
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
      setResults(list);
      setDropdownOpen(true);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setQuery(v);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(() => void doSearch(v), 300);
    },
    [doSearch],
  );

  const addStaff = useCallback(
    (staff: StaffItem) => {
      staffCacheRef.current.set(staff.workNo, staff);
      if (!selectedIds.includes(staff.workNo)) {
        onChange([...selectedIds, staff.workNo].join(','));
      }
      setQuery('');
      setDropdownOpen(false);
    },
    [onChange, selectedIds],
  );

  const removeStaff = useCallback(
    (id: string) => {
      onChange(selectedIds.filter((s) => s !== id).join(','));
    },
    [onChange, selectedIds],
  );

  return (
    <div className="staff-select" ref={containerRef}>
      <div className="staff-select-tags">
        {selectedIds.map((id) => {
          const cached = staffCacheRef.current.get(id);
          const label = cached ? `${cached.nickName || cached.name || id}(${id})` : id;
          return (
            <span key={id} className="staff-tag">
              {label}
              <button type="button" onClick={() => removeStaff(id)} aria-label="移除">×</button>
            </span>
          );
        })}
        <input
          className="staff-select-input"
          value={query}
          onChange={handleInputChange}
          onFocus={() => { if (results.length > 0) setDropdownOpen(true); }}
          placeholder={selectedIds.length === 0 ? (placeholder || '搜索花名/工号/姓名') : '继续添加...'}
        />
      </div>
      {dropdownOpen && results.length > 0 ? (
        <div className="staff-select-dropdown">
          {results.map((staff) => (
            <button
              key={staff.workNo}
              type="button"
              className={selectedIds.includes(staff.workNo) ? 'selected' : ''}
              onClick={() => addStaff(staff)}
            >
              <strong>{staff.nickName || staff.name || staff.workNo}</strong>
              <span>{staff.workNo}</span>
              {staff.name ? <span className="staff-realname">{staff.name}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {searching ? <div className="staff-select-loading">搜索中...</div> : null}
    </div>
  );
}
