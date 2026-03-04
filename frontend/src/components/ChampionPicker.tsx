import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

interface ChampionPickerProps {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  getLabel: (value: string) => string;
  getIconUrl: (value: string) => string;
  noResultsLabel: string;
}

export default function ChampionPicker(props: ChampionPickerProps) {
  const { label, value, options, onChange, getLabel, getIconUrl, noResultsLabel } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const [iconReadyByKey, setIconReadyByKey] = useState<Record<string, boolean>>({});
  const containerRef = useRef<HTMLDivElement | null>(null);

  /** Convert hiragana characters to their katakana equivalents for fuzzy-matching. */
  function toKatakana(str: string): string {
    return str.replace(/[\u3041-\u3096]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
  }

  const filteredOptions = useMemo(() => {
    const normalizedQuery = toKatakana(query.trim().toLowerCase());
    if (!normalizedQuery) return options;
    return options.filter((option) => toKatakana(getLabel(option).toLowerCase()).includes(normalizedQuery));
  }, [options, query, getLabel]);

  useEffect(() => {
    setHighlightedIdx(0);
  }, [query, open]);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (event.target instanceof Node && !containerRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      setHighlightedIdx((idx) => (idx + 1) % filteredOptions.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      setHighlightedIdx((idx) => (idx - 1 + filteredOptions.length) % filteredOptions.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const selected = filteredOptions[highlightedIdx];
      if (!selected) return;
      onChange(selected);
      setOpen(false);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };

  const selectedIconUrl = getIconUrl(value);

  const markIconReady = (key: string) => {
    setIconReadyByKey((current) => (current[key] ? current : { ...current, [key]: true }));
  };

  const renderIcon = (iconUrl: string, key: string) => {
    if (!iconUrl) return <span className="champion-icon-skeleton" aria-hidden="true" />;
    const isReady = iconReadyByKey[key] ?? false;
    return (
      <span className="champion-icon-frame" aria-hidden="true">
        {!isReady ? <span className="champion-icon-skeleton pulse" /> : null}
        <img
          className={`champion-icon${isReady ? "" : " loading"}`}
          src={iconUrl}
          alt=""
          loading="lazy"
          onLoad={() => markIconReady(key)}
          onError={() => markIconReady(key)}
        />
      </span>
    );
  };

  return (
    <div className="champion-picker" ref={containerRef}>
      <span className="champion-picker-label">{label}</span>
      <button
        type="button"
        className="champion-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((state) => !state)}
      >
        {renderIcon(selectedIconUrl, `selected:${selectedIconUrl}`)}
        <span>{getLabel(value) || "-"}</span>
      </button>
      {open ? (
        <div className="champion-picker-popover">
          <input
            className="champion-picker-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={label}
            autoFocus
          />
          <ul className="champion-picker-options" role="listbox">
            {filteredOptions.length === 0 ? (
              <li className="champion-picker-empty">{noResultsLabel}</li>
            ) : (
              filteredOptions.map((option, index) => {
                const optionIconUrl = getIconUrl(option);
                const isHighlighted = index === highlightedIdx;
                const isSelected = option === value;
                return (
                  <li key={option}>
                    <button
                      type="button"
                      className={`champion-picker-option${isHighlighted ? " highlighted" : ""}${isSelected ? " selected" : ""
                        }`}
                      onMouseEnter={() => setHighlightedIdx(index)}
                      onClick={() => {
                        onChange(option);
                        setOpen(false);
                      }}
                    >
                      {renderIcon(optionIconUrl, `option:${optionIconUrl}`)}
                      <span>{getLabel(option)}</span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
