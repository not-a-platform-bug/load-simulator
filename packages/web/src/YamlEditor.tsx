import { useEffect, useRef, useState } from 'react';

/** Plain textarea editor: edits are parsed on pause; canvas/slider edits flow back in when not focused. */
export function YamlEditor({ text, error, onChange }: { text: string; error: string | null; onChange: (t: string) => void }) {
  const [value, setValue] = useState(text);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setValue(text);
  }, [text]);
  useEffect(() => {
    if (value === text) return;
    const t = setTimeout(() => onChange(value), 400);
    return () => clearTimeout(t);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="yaml">
      <textarea
        spellCheck={false}
        value={value}
        onFocus={() => (focused.current = true)}
        onBlur={() => (focused.current = false)}
        onChange={(e) => setValue(e.target.value)}
        aria-label="시나리오 YAML"
      />
      {error && <div className="yaml-error">{error}</div>}
    </div>
  );
}
