// Original 16x16 pixel icons, drawn as text so they stay crisp at any size.
const INK: Record<string, string> = {
  k: "#21182b", w: "#fff3dc", g: "#7ccb57", G: "#4f8f3a", d: "#9a6742", D: "#6f4a30",
  s: "#c3c1cc", S: "#7d7b88", y: "#ffe29a", Y: "#f5b94d", O: "#e57f5f", r: "#e0584f", R: "#9c3532",
  b: "#8fd0f2", B: "#3d7ab8", p: "#a77bd6", P: "#6b4d7a", t: "#c28e58", T: "#855b36",
};

export const SPRITES = {
  grass: ["......kkkk......", "....kkggggkk....", "..kkgggGggggkk..", "kkggGgggggggGgkk", "kGgggggggggggggk", "kDGgggggggggGddk", "kDDGGggggGGdddDk", "kDdDDDGGdddDdddk", "kDDDdDDkdddddDdk", "kDdDDDDkddDddddk", "kDDDDdDkdddDdddk", "kDdDDDDkddddDddk", ".kkDDdDkdDdddkk.", "...kkDDkddkk....", ".....kkkkk......", "................"],
  chest: ["................", "..kkkkkkkkkkkk..", ".ktttttttttttTk.", ".kttTtttttTtttk.", ".ktttttttttttTk.", ".kkkkkkyykkkkkk.", ".kTTTTkYYkTTTTk.", ".ktttTkkkkTtttk.", ".kttttttttttttk.", ".kTttttTttttTtk.", ".kttttttttttttk.", ".kTTTTTTTTTTTTk.", "..kkkkkkkkkkkk..", "................", "................", "................"],
  pickaxe: ["................", "...kkkkkkkk.....", "..kbbbbbbbBk....", ".kbbBBBBBbbBk...", ".kkkk...kTkbBk..", ".......kTtkkbBk.", "......kTtk.kbBk.", ".....kTtk..kbBk.", "....kTtk...kBBk.", "...kTtk....kBk..", "..kTtk......k...", ".kTtk...........", "kTtk............", "kkk.............", "................", "................"],
  anvil: ["................", "................", ".kkkkkkkkkkkkkk.", "kSssssssssssssSk", ".kSSSSSSSSSSSSk.", "..kkkSSSSSSkkk..", ".....kSSSSk.....", ".....kSSSSk.....", ".....kSSSSk.....", "....kSSSSSSk....", "..kkSSSSSSSSkk..", ".kssssssssssssk.", ".kSSSSSSSSSSSSk.", ".kkkkkkkkkkkkkk.", "................", "................"],
  gear: ["......kkkk......", "..kk..kssk..kk..", ".kssk.kssk.kssk.", ".ksssksssskssSk.", "..kssssssssssk..", "...ksssSSsssk...", "kkkssSkkkkSsskkk", "kssssSk..kSssssk", "kSsssSk..kSsssSk", "kkkssSkkkkSsskkk", "...kssSSSSssk...", "..kssssssssssk..", ".ksSsksssskSSsk.", ".kSSk.kSSk.kSSk.", "..kk..kSSk..kk..", "......kkkk......"],
  lantern: ["......kkkk......", ".....kS..Sk.....", "......kkkk......", "....kkSSSSkk....", "...kSSSSSSSSk...", "...kkkkkkkkkk...", "...kSyyyyyySk...", "...kSyYwwYySk...", "...kSyYwwYySk...", "...kSyyYYyySk...", "...kSyyyyyySk...", "...kkkkkkkkkk...", "...kSSSSSSSSk...", "....kkkkkkkk....", "................", "................"],
  painting: ["kkkkkkkkkkkkkkkk", "kTTTTTTTTTTTTTTk", "kTbbbbbbbbbbbbTk", "kTbbbbbbyyybbbTk", "kTbbbbbbyyybbbTk", "kTbbbbbbyyybbbTk", "kTbbbpbbbbbbbbTk", "kTbbpPpbbbpbbbTk", "kTbpPPPpbpPpbbTk", "kTpPPPPPpPPPpbTk", "kTgggggggggggGTk", "kTGgGggGgggGggTk", "kTDdDDdDDdDDdDTk", "kTTTTTTTTTTTTTTk", "kkkkkkkkkkkkkkkk", "................"],
  book: ["................", "..kkkkkkkkkkk...", ".kRrrrrrrrrrrk..", ".kRrrYYYYYrrrk..", ".kRrrYrrrYrrrk..", ".kRrrYYYYYrrrk..", ".kRrrrrrrrrrrk..", ".kRrrrrrrrrrrk..", ".kRrrrrrrrrrrk..", ".kRrrrrrrrrrrk..", ".kRkkkkkkkkkkk..", ".kRwwwwwwwwwwk..", ".kRSSSSSSSSSSk..", "..kkkkkkkkkkk...", "................", "................"],
  compass: ["................", ".....kkkkkk.....", "...kkSsssSSkk...", "..kSswwwwwwsSk..", "..kswwwwwrRwsk..", ".kSswwwwrRwwssk.", ".kswwwwrRwwwwsk.", ".kswwwkRkwwwwsk.", ".kswwwSkwwwwwsk.", ".kswwSbwwwwwwsk.", ".kSsSBwwwwwwssk.", "..ksBwwwwwwwsk..", "..kSswwwwwwsSk..", "...kkSsssSSkk...", ".....kkkkkk.....", "................"],
  map: ["................", ".kkkkkkkkkkkkkk.", ".kwwwwwwwwwwwwk.", ".kwbbbbbbgggwwk.", ".kwbbbbbggGggwk.", ".kwbbbggggggrwk.", ".kwbbgggGggrwwk.", ".kwbgggggrwgwwk.", ".kwbbgGgggwgwwk.", ".kwbbbggggggwwk.", ".kwbbbbbgggbwwk.", ".kwwwwwwwwwwwwk.", ".kkkkkkkkkkkkkk.", "................", "................", "................"],
  chain: ["................", "........kkkk....", ".......kssSSk...", "......ksk..kSk..", "......ksk..kSk..", "......kssk.kSk..", ".....kkksskSk...", "....ksSkkkkk....", "...ksk.kssk.....", "..ksk...ksk.....", "..kSk...ksk.....", "..kSk..kSk......", "...kSSSSk.......", "....kkkk........", "................", "................"],
  sword: ["............kkk.", "...........kwbk.", "..........kwbBk.", ".........kwbBk..", "........kwbBk...", ".......kwbBk....", "..k...kwbBk.....", ".kYk.kwbBk......", "..kYkwbBk.......", "...kYbBk........", "...kTYk.........", "..kTkkYk........", ".kTk..kYk.......", "kkk....k........", "................", "................"],
  apple: ["................", ".......kk.......", "......kTk.gg....", ".......kTkgG....", "...kkkkkTkkkk...", "..krrrrrrrrrRk..", ".krwrrrrrrrrRRk.", ".krwrrrrrrrrrRk.", ".krrrrrrrrrrrRk.", ".krrrrrrrrrrRRk.", "..krrrrrrrrRRk..", "..kRrrrrrrRRRk..", "...kRRkkkRRRk...", "....kk...kkk....", "................", "................"],
  pane: ["kkkkkkkkkkkkkkkk", "kSSSSSSSSSSSSSSk", "kSbbbbbbSbbbbbSk", "kSbwbbbbSbwbbbSk", "kSbbwbbbSbbwbbSk", "kSbbbbbbSbbbbbSk", "kSbbbbbbSbbbbbSk", "kSSSSSSSSSSSSSSk", "kSbbbbbbSbbbbbSk", "kSbwbbbbSbwbbbSk", "kSbbwbbbSbbwbbSk", "kSbbbbbbSbbbbbSk", "kSbbbbbbSbbbbbSk", "kSSSSSSSSSSSSSSk", "kkkkkkkkkkkkkkkk", "................"],
  penguin: ["................", ".....kkkkkk.....", "....kkkkkkkk....", "...kkwkkkkwkk...", "...kkkkYYkkkk...", "...kkkYYYYkkk...", "..kkkwwwwwwkkk..", ".kkkwwwwwwwwkkk.", ".kk.kwwwwwwk.kk.", ".k..kwwwwwwk..k.", "....kwwwwwwk....", "....kkwwwwkk....", "...YYYkkkkYYY...", "..YYYY....YYYY..", "................", "................"],
} as const;

export type SpriteName = keyof typeof SPRITES;

export function Sprite({ name, size = 32 }: { name: SpriteName; size?: number }) {
  const rects = SPRITES[name].flatMap((row, y) => {
    const runs = [];
    for (let x = 0; x < row.length; ) {
      let end = x + 1;
      while (row[end] === row[x]) end++;
      if (INK[row[x]]) runs.push(<rect key={x} x={x} y={y} width={end - x} height={1} fill={INK[row[x]]} />);
      x = end;
    }
    return <g key={y}>{runs}</g>;
  });
  return (
    <svg className="sprite" viewBox="0 0 16 16" width={size} height={size} shapeRendering="crispEdges" aria-hidden>
      {rects}
    </svg>
  );
}
