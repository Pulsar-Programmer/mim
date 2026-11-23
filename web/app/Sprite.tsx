// Original 16x16 pixel icons, drawn as text so they stay crisp at any size.
// The isometric blocks come from scripts/draw_blocks.py.
const INK: Record<string, string> = {
  k: "#21182b", w: "#fff3dc", g: "#7ccb57", G: "#4f8f3a", d: "#9a6742", D: "#6f4a30",
  s: "#c3c1cc", S: "#7d7b88", y: "#ffe29a", Y: "#f5b94d", O: "#e57f5f", r: "#e0584f", R: "#9c3532",
  c: "#4fe3d2", C: "#1f9c8e", e: "#c8fff5", E: "#14665f", h: "#fff6b0", i: "#ffd23f", I: "#dc9a1f", J: "#8f5a12",
  m: "#f4e6c4", M: "#c7ad7c", n: "#e4f8ff", q: "#b4e4f650",
  b: "#8fd0f2", B: "#3d7ab8", p: "#a77bd6", P: "#6b4d7a", t: "#c28e58", T: "#855b36",
};

export const SPRITES = {
  pickaxe: ["................", "....kkkkkkkk....", "...keecccccCk...", "....kkkkkccCCk..", "........ktkccCk.", ".......kTtkkcCk.", "......kTtk..kcCk", ".....kTtk...kcCk", "....kTtk....kcCk", "...kTtk.....kCCk", "..kTtk.......kk.", ".kTtk...........", "kTtk............", "kkk.............", "................", "................"],
  anvil: ["................", "................", ".kkkkkkkkkkkkkk.", "kSssssssssssssSk", ".kSSSSSSSSSSSSk.", "..kkkSSSSSSkkk..", ".....kSSSSk.....", ".....kSSSSk.....", ".....kSSSSk.....", "....kSSSSSSk....", "..kkSSSSSSSSkk..", ".kssssssssssssk.", ".kSSSSSSSSSSSSk.", ".kkkkkkkkkkkkkk.", "................", "................"],
  gear: ["......kkkk......", "..kk..kssk..kk..", ".kssk.kssk.kssk.", ".ksssksssskssSk.", "..kssssssssssk..", "...ksssSSsssk...", "kkkssSkkkkSsskkk", "kssssSk..kSssssk", "kSsssSk..kSsssSk", "kkkssSkkkkSsskkk", "...kssSSSSssk...", "..kssssssssssk..", ".ksSsksssskSSsk.", ".kSSk.kSSk.kSSk.", "..kk..kSSk..kk..", "......kkkk......"],
  lantern: ["......kkkk......", ".....kS..Sk.....", "......kkkk......", "....kkSSSSkk....", "...kSSSSSSSSk...", "...kkkkkkkkkk...", "...kSyyyyyySk...", "...kSyYwwYySk...", "...kSyYwwYySk...", "...kSyyYYyySk...", "...kSyyyyyySk...", "...kkkkkkkkkk...", "...kSSSSSSSSk...", "....kkkkkkkk....", "................", "................"],
  painting: ["kkkkkkkkkkkkkkkk", "kTTTTTTTTTTTTTTk", "kTbbbbbbbbbbbbTk", "kTbbbbbbyyybbbTk", "kTbbbbbbyyybbbTk", "kTbbbbbbyyybbbTk", "kTbbbpbbbbbbbbTk", "kTbbpPpbbbpbbbTk", "kTbpPPPpbpPpbbTk", "kTpPPPPPpPPPpbTk", "kTgggggggggggGTk", "kTGgGggGgggGggTk", "kTDdDDdDDdDDdDTk", "kTTTTTTTTTTTTTTk", "kkkkkkkkkkkkkkkk", "................"],
  book: ["................", "..kkkkkkkkkkk...", ".kRrrrrrrrrrrk..", ".kRrrYYYYYrrrk..", ".kRrrYrrrYrrrk..", ".kRrrYYYYYrrrk..", ".kRrrrrrrrrrrk..", ".kRrrrrrrrrrrk..", ".kRrrrrrrrrrrk..", ".kRrrrrrrrrrrk..", ".kRkkkkkkkkkkk..", ".kRwwwwwwwwwwk..", ".kRSSSSSSSSSSk..", "..kkkkkkkkkkk...", "................", "................"],
  compass: ["................", ".....kkkkkk.....", "...kkSsssSSkk...", "..kSswwwwwwsSk..", "..kswwwwwrRwsk..", ".kSswwwwrRwwssk.", ".kswwwwrRwwwwsk.", ".kswwwkRkwwwwsk.", ".kswwwSkwwwwwsk.", ".kswwSbwwwwwwsk.", ".kSsSBwwwwwwssk.", "..ksBwwwwwwwsk..", "..kSswwwwwwsSk..", "...kkSsssSSkk...", ".....kkkkkk.....", "................"],
  map: ["................", ".kkkkkkkkkkkkkk.", ".kmmmmmmmmmmmmk.", ".kmBBbbbyggGgmk.", ".kmBbbbyggggGmk.", ".kmbbbyyggrGgmk.", ".kmbbyggGrrrgmk.", ".kmbyggggGrggmk.", ".kmyggGggggyymk.", ".kmggggGgyybbmk.", ".kmgGggyybbbBmk.", ".kmggyybbbBBBmk.", ".kmmmmmmmmmmmmk.", ".kMMMMMMMMMMMMk.", ".kkkkkkkkkkkkkk.", "................"],
  chain: ["................", "........kkkk....", ".......kssSSk...", "......ksk..kSk..", "......ksk..kSk..", "......kssk.kSk..", ".....kkksskSk...", "....ksSkkkkk....", "...ksk.kssk.....", "..ksk...ksk.....", "..kSk...ksk.....", "..kSk..kSk......", "...kSSSSk.......", "....kkkk........", "................", "................"],
  sword: [".............kkk", "............kwsk", "...........kwsSk", "..........kwsSk.", ".........kwsSk..", "........kwsSk...", ".......kwsSk....", "..kk..kwsSk.....", ".kSSkkwsSk......", "..kSSwsSk.......", "...kSSSk........", "...kTkSSk.......", "..kTtk.kk.......", ".kTtk...........", "kSSk............", ".kk............."],
  apple: ["........kk......", ".......kTk.kk...", "........kTkgGk..", "....kkkkkTkkk...", "...kiiiiiiiiik..", "..khhiiiiiiiiIk.", ".khhiiiiiiiiiIIk", ".khiiiiiiiiiiIIk", ".khiiiiiiiiiiIIk", ".kiiiiiiiiiiIIIk", "..kiiiiiiiiIIIk.", "..kIiiiiiiIIIJk.", "...kIIkkkIIIJk..", "....kk...kkkk...", "................", "................"],
  pane: ["nnnnnnnnnnnnnnnn", "nqqqqqqqqqqqqqqB", "nqwwqqqqqqqqqqqB", "nqwqqqqqqqqqqqqB", "nqqqqqqqqqqqqqqB", "nqqqqqqwqqqqqqqB", "nqqqqqwqqqqqqqqB", "nqqqqwqqqqqqqqqB", "nqqqqqqqqqqqqqqB", "nqqqqqqqqqqqqqqB", "nqqqqqqqqqqqqqqB", "nqqqqqqqqqqqqqqB", "nqqqqqqqqqqqwqqB", "nqqqqqqqqqqwwqqB", "nqqqqqqqqqqqqqqB", "BBBBBBBBBBBBBBBB"],
  penguin: ["................", ".....kkkkkk.....", "....kkkkkkkk....", "...kkwkkkkwkk...", "...kkkkYYkkkk...", "...kkkYYYYkkk...", "..kkkwwwwwwkkk..", ".kkkwwwwwwwwkkk.", ".kk.kwwwwwwk.kk.", ".k..kwwwwwwk..k.", "....kwwwwwwk....", "....kkwwwwkk....", "...YYYkkkkYYY...", "..YYYY....YYYY..", "................", "................"],
  sunny: ["................", ".......yy.......", ".......yy.......", "..yy........yy..", "..yy.yyyyyy.yy..", ".....yyyyyy.....", "....yyyyyyyy....", ".yy.yyyyyyyy.yy.", ".yy.yyyyyyyy.yy.", "....yyyyyyyy....", ".....yyyyyy.....", "..yy.yyyyyy.yy..", "..yy........yy..", ".......yy.......", ".......yy.......", "................"],
  moon: ["................", "......PPPP......", "....PPPPpp......", "...PPPpp........", "..PPPpp.........", "..PPPp..........", ".PPPpp..........", ".PPPpp..........", ".PPPpp.........P", ".PPPPpp.......PP", "..PPPPpp.....PP.", "..PPPPPppppPPP..", "...PPPPPPPPPp...", "....PPPPPPpp....", "......PPPP......", "................"],
} as const;

const BLOCKS = ["grass", "chest"] as const;

export type SpriteName = keyof typeof SPRITES | (typeof BLOCKS)[number];

export function Sprite({ name, size = 32 }: { name: SpriteName; size?: number }) {
  if (name === "grass" || name === "chest") {
    return <img className="sprite" src={`/img/icons/${name}.png`} width={size} height={size} alt="" aria-hidden />;
  }
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
