import React, { useMemo } from "react";
import { useLibraryStore } from "../store/useLibraryStore";

const ALPHABET = [
  "#", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
  "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
];

export const AlphabetJumpBar: React.FC<{ onSelectLetter: (l: string) => void }> = ({ onSelectLetter }) => {
  const { artists } = useLibraryStore();
  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const a of artists) map[a.first_letter] = (map[a.first_letter] || 0) + 1;
    return map;
  }, [artists]);

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4, padding: "5px 12px", background: "rgba(10, 12, 18, 0.92)", borderBottom: "1px solid var(--border-subtle)", flexWrap: "wrap" }}>
      {ALPHABET.map((letter) => {
        const count = counts[letter] || 0;
        const active = count > 0;
        return (
          <button
            key={letter}
            disabled={!active}
            onClick={() => onSelectLetter(letter)}
            style={{
              background: active ? "rgba(255, 255, 255, 0.05)" : "transparent",
              border: "1px solid",
              borderColor: active ? "rgba(0, 210, 255, 0.22)" : "transparent",
              color: active ? "#f3f4f6" : "rgba(156, 163, 175, 0.28)",
              borderRadius: 5, padding: "2px 6px", fontSize: 11, fontWeight: 600,
              cursor: active ? "pointer" : "default", display: "flex", alignItems: "center", gap: 3,
            }}
          >
            <span>{letter}</span>
            {active && <span style={{ fontSize: 9, color: "#00d2ff" }}>({count})</span>}
          </button>
        );
      })}
    </div>
  );
};