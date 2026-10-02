// Pool de cartas. Monstros: [nome, emoji, atk, def]. Sacrifícios: ATK >= 1800 pede 1, ATK >= 2500 pede 2.
const MONSTERS = [
  ['Filhote de Clawd', '🦀', 600, 500],
  ['Bug Roxo', '🐛', 800, 400],
  ['Slime Verde', '🟢', 700, 900],
  ['Goblin Ladrão', '👺', 1200, 800],
  ['Esqueleto Guerreiro', '💀', 1400, 1000],
  ['Mago Aprendiz', '🧙', 1300, 1200],
  ['Golem de Pedra', '🗿', 1000, 2000],
  ['Sereia Mística', '🧜', 1500, 1700],
  ['Anjo Guardião', '👼', 1600, 2200],
  ['Lobo Sombrio', '🐺', 1700, 1000],
  ['Cavaleiro Real', '🛡️', 1800, 1600],
  ['Unicórnio Sagrado', '🦄', 1900, 1900],
  ['Fênix Flamejante', '🔥', 2000, 1200],
  ['Vampiro Noturno', '🧛', 2100, 1300],
  ['Tubarão Abissal', '🦈', 2200, 1400],
  ['Robô Titã', '🤖', 2300, 2000],
  ['Dragão Jovem', '🐉', 2400, 1500],
  ['Demônio Carmesim', '😈', 2600, 1800],
  ['Kraken', '🐙', 2800, 2100],
  ['Dragão Ancestral', '🐲', 3000, 2500],
];
const tributesFor = atk => (atk >= 2500 ? 2 : atk >= 1800 ? 1 : 0);

const SPELLS = [
  { name: 'Poção de Cura', emoji: '🧪', effect: 'heal', value: 1500, target: null, text: 'Recupere 1500 LP.' },
  { name: 'Raio', emoji: '⚡', effect: 'burn', value: 1000, target: null, text: 'Cause 1000 de dano ao oponente.' },
  { name: 'Explosão', emoji: '💥', effect: 'destroy', target: 'enemy', text: 'Destrói 1 monstro do oponente.' },
  { name: 'Fortalecer', emoji: '💪', effect: 'boost', value: 600, target: 'ally', text: 'Um monstro seu ganha +600 ATK e DEF.' },
  { name: 'Sabedoria', emoji: '📖', effect: 'draw', value: 2, target: null, text: 'Compre 2 cartas.' },
  { name: 'Tempestade', emoji: '🌪️', effect: 'sweep', target: null, text: 'Destrói todos os monstros dos dois campos.' },
  { name: 'Vento Cortante', emoji: '🍃', effect: 'destroyTrap', target: 'enemyTrap', text: 'Destrói 1 armadilha do oponente.' },
];

// Armadilhas: baixadas viradas para baixo, ativam sozinhas a partir do turno seguinte.
const TRAPS = [
  { name: 'Espelho Mágico', emoji: '🪞', effect: 'mirror', text: 'Quando o oponente atacar: destrói o atacante.' },
  { name: 'Barreira Sagrada', emoji: '🔰', effect: 'barrier', text: 'Quando o oponente atacar: anula o ataque.' },
  { name: 'Chamas Vingativas', emoji: '🔥', effect: 'revenge', value: 1500, text: 'Quando o oponente atacar: ele sofre 1500 de dano e o ataque continua.' },
  { name: 'Fosso Sem Fundo', emoji: '🕳️', effect: 'pit', text: 'Quando o oponente invocar monstro com 1500+ ATK em ataque: destrói-o.' },
  { name: 'Selo Arcano', emoji: '🔮', effect: 'negate', text: 'Quando o oponente usar uma magia: anula a magia.' },
];

const shuffle = a => {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

function buildDeck() {
  const mons = shuffle(MONSTERS.map(([name, emoji, atk, def]) => ({ type: 'monster', name, emoji, atk, def, tributes: tributesFor(atk) })));
  const weak = mons.filter(m => !m.tributes), rest = mons.filter(m => m.tributes);
  const pickM = [...weak.slice(0, 8), ...shuffle([...weak.slice(8), ...rest]).slice(0, 9)];
  const others = [];
  SPELLS.forEach(s => { others.push({ type: 'spell', ...s }); others.push({ type: 'spell', ...s }); });
  TRAPS.forEach(t => { others.push({ type: 'trap', ...t }); others.push({ type: 'trap', ...t }); });
  let n = 0;
  return shuffle([...pickM, ...shuffle(others).slice(0, 13)]).map(c => ({ ...c, uid: Math.random().toString(36).slice(2) + (n++) }));
}

module.exports = { buildDeck };
