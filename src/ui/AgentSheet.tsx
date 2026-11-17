import { RECIPES, type Recipe } from "../agents/recipes";
import { AGENTS } from "../agents/registry";
import { Icon, isIconName } from "./Icon";
import { Sheet } from "./Sheet";

export function AgentSheet({ open, current, auto, onPick, onPickAuto, onPickRecipe, onClose }: { open: boolean; current: string; auto: boolean; onPick: (id: string) => void; onPickAuto: () => void; onPickRecipe: (r: Recipe) => void; onClose: () => void }) {
  return (
    <Sheet open={open} title="Агенти" onClose={onClose}>
      <p className="note first">Агента можна також вибрати командою на початку задачі.</p>
      <div className="alist">
        <button className="agent" aria-current={auto} onClick={onPickAuto}>
          <span className="aico" aria-hidden="true">
            ✦
          </span>
          <span>
            <span className="aname">Авто</span>
            <span className="adesc">Опишіть задачу своїми словами: роутер запропонує агента або ланцюг, а ви підтвердите план перед запуском.</span>
            <span className="dt">без команди</span>
          </span>
          <span className="pill">fast</span>
        </button>
        {AGENTS.map((a) => (
          <button key={a.id} className="agent" aria-current={!auto && a.id === current} onClick={() => onPick(a.id)}>
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
      <p className="note">Рецепти: кілька агентів однією командою. Тап підставляє команду в поле, лишається дописати платформу й тему.</p>
      <div className="alist">
        {RECIPES.map((r) => (
          <button key={r.id} className="agent" onClick={() => onPickRecipe(r)}>
            <span className="aico" aria-hidden="true">
              ⚡
            </span>
            <span>
              <span className="aname">{r.name}</span>
              <span className="adesc">{r.description}</span>
              <span className="dt">{r.commands.join("  ")}</span>
            </span>
            <span className="pill">ланцюг</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}
