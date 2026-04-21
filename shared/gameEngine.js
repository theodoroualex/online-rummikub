const COLORS = ['red', 'blue', 'black', 'orange'];
const NUMBERS = Array.from({ length: 13 }, (_, i) => i + 1);
const INITIAL_RACK_SIZE = 14;
const MAX_PLAYERS = 4;

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function createShuffledTileSet() {
  const tiles = [];
  let id = 1;
  for (let copy = 0; copy < 2; copy++) {
    for (const color of COLORS) {
      for (const number of NUMBERS) {
        tiles.push({ id: `t${id++}`, color, number, joker: false });
      }
    }
  }
  tiles.push({ id: `t${id++}`, color: null, number: null, joker: true });
  tiles.push({ id: `t${id++}`, color: null, number: null, joker: true });
  return shuffle(tiles);
}

function cloneBoard(board) {
  return board.map((set) => ({ id: set.id, tiles: [...set.tiles] }));
}

function flattenBoard(board) {
  return board.flatMap((set) => set.tiles);
}

function makeSetId() {
  return `set_${Math.random().toString(36).slice(2, 10)}`;
}

function sortByNumber(tiles) {
  return [...tiles].sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
}

function validateGroup(tiles) {
  if (tiles.length < 3 || tiles.length > 4) return false;
  const jokers = tiles.filter((t) => t.joker);
  const normals = tiles.filter((t) => !t.joker);
  if (normals.length === 0) return true;
  const number = normals[0].number;
  if (!normals.every((t) => t.number === number)) return false;
  const colors = normals.map((t) => t.color);
  if (new Set(colors).size !== colors.length) return false;
  return normals.length + jokers.length >= 3 && normals.length + jokers.length <= 4;
}

function validateRun(tiles) {
  if (tiles.length < 3) return false;
  const jokers = tiles.filter((t) => t.joker);
  const normals = sortByNumber(tiles.filter((t) => !t.joker));
  if (normals.length === 0) return true;
  const color = normals[0].color;
  if (!normals.every((t) => t.color === color)) return false;
  const nums = normals.map((t) => t.number);
  if (new Set(nums).size !== nums.length) return false;
  let jokersLeft = jokers.length;
  for (let i = 1; i < nums.length; i++) {
    const gap = nums[i] - nums[i - 1] - 1;
    if (gap < 0) return false;
    if (gap > jokersLeft) return false;
    jokersLeft -= gap;
  }
  return true;
};