import { AGENTS } from "../agents/registry";
import { Icon, isIconName } from "./Icon";
import { Sheet } from "./Sheet";

export function AgentSheet({ open, current, onPick, onClose }: { open: boolean; current: string; onPick: (id: string) => void; onClose: () => void }) {
  return (
    <Sheet open={open} title="Агенти" onClose={onClose}>
      <p className="note first">Агента можна також вибрати командою на початку задачі.</p>
      <div className="alist">
        {AGENTS.map((a) => (
          <button key={a.id} className="agent" aria-current={a.id === current} onClick={() => onPick(a.id)}>
            <span className="aico">{isIconName(a.icon) && <Icon name={a.icon} />}</span>
            <span>
              <span className="aname">{a.name}</span>
              <span className="adesc">{a.description}</span>
              <span className="dt">{a.commands.join("  ")}</span>
            </span>
            <span className="pill">{a.model}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}
