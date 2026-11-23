export type SpriteName =
  | "grass" | "chest" | "wool" | "crafting" | "furnace" | "blast" | "pickaxe" | "sword" | "chain"
  | "apple" | "book" | "map" | "compass" | "painting" | "lantern" | "xp" | "pane" | "penguin";

export function Sprite({ name, size = 32 }: { name: SpriteName; size?: number }) {
  return <img className="sprite" src={`/img/mc/${name}.png`} width={size} height={size} alt="" aria-hidden />;
}
