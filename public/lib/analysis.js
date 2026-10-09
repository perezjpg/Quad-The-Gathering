// Análisis de la partida: resumen por jugador, gráfica de vida e interpretación en texto.
// Funciona sobre el estado del motor (navegador o servidor) y devuelve datos serializables.

import { power } from './engine.js';

const isCreature = (c) => /\bCreature\b/.test(c.typeLine || '');

export function matchAnalysis(game) {
  const players = game.players.map((p) => {
    const st = p.stats;
    const creatures = p.battlefield.filter(isCreature);
    const boardPower = creatures.reduce((n, c) => n + Math.max(0, power(game, c)), 0);
    const totalDamage = st.combatDamage + st.otherDamage;
    const [mvpName, mvpDamage] = Object.entries(st.sources).sort((a, b) => b[1] - a[1])[0] || [null, 0];
    const cmdTaken = Math.max(0, ...Object.values(p.commanderDamage));
    return {
      idx: p.idx,
      name: p.name,
      color: p.color,
      alive: p.alive,
      life: p.life,
      poison: p.poison,
      cmdTaken,
      boardPower,
      creatures: creatures.length,
      lands: p.battlefield.filter((c) => /\bLand\b/.test(c.typeLine)).length,
      handCount: p.hand.length,
      totalDamage,
      combatDamage: st.combatDamage,
      otherDamage: st.otherDamage,
      biggestHit: st.biggestHit,
      spells: st.spells,
      manaSpent: st.manaSpent,
      landsPlayed: st.lands,
      draws: st.draws,
      creaturesLost: st.creaturesLost,
      removal: st.removal,
      counters: st.counters,
      lifeGained: st.lifeGained,
      mvp: mvpName ? { name: mvpName, damage: mvpDamage } : null,
      eliminatedTurn: st.eliminatedTurn,
      eliminatedReason: st.eliminatedReason,
      // Amenaza: vida + presión en mesa + recursos (heurística para la lectura de mesa)
      threat: p.alive ? Math.round(p.life * 0.5 + boardPower * 2 + creatures.length + p.hand.length + totalDamage * 0.3) : 0,
    };
  });
  return { turn: game.turn, winner: game.winner, players, lifeHistory: game.lifeHistory, insights: insights(game, players) };
}

function insights(game, players) {
  const out = [];
  const alive = players.filter((p) => p.alive);
  const top = (key) => [...players].sort((a, b) => b[key] - a[key])[0];

  if (game.winner != null) {
    const w = players[game.winner];
    out.push(`🏆 ${w.name} ganó en el turno ${game.turn}${w.mvp ? `; su carta clave fue ${w.mvp.name} (${w.mvp.damage} de daño)` : ''}.`);
  } else if (alive.length > 1) {
    const threat = [...alive].sort((a, b) => b.threat - a.threat)[0];
    out.push(`🎯 Mayor amenaza ahora: ${threat.name} (vida ${threat.life}, fuerza en mesa ${threat.boardPower}, ${threat.handCount} cartas en mano).`);
  }
  const dmg = top('totalDamage');
  if (dmg.totalDamage > 0) out.push(`⚔️ ${dmg.name} es quien más daño ha hecho: ${dmg.totalDamage} (${dmg.combatDamage} en combate).`);
  const hit = top('biggestHit');
  if (hit.biggestHit >= 5) out.push(`💥 Golpe más fuerte: ${hit.biggestHit} de ${hit.name}.`);
  const eff = players.filter((p) => p.manaSpent >= 5).sort((a, b) => b.totalDamage / b.manaSpent - a.totalDamage / a.manaSpent)[0];
  if (eff && eff.totalDamage > 0) out.push(`💎 Mejor eficiencia de maná: ${eff.name}, ${(eff.totalDamage / eff.manaSpent).toFixed(1)} de daño por cada maná gastado.`);
  const lost = top('creaturesLost');
  if (lost.creaturesLost >= 3) out.push(`🪦 ${lost.name} ha perdido más criaturas (${lost.creaturesLost}); le conviene buscar protección o recursión.`);
  const cmd = players.filter((p) => p.alive && p.cmdTaken >= 14);
  for (const p of cmd) out.push(`🗡 Cuidado: ${p.name} lleva ${p.cmdTaken} de daño de comandante (21 = derrota).`);
  const low = alive.filter((p) => p.life <= 10);
  for (const p of low) out.push(`❤️ ${p.name} está en peligro con ${p.life} de vida.`);
  const flooding = alive.filter((p) => p.lands >= 7 && p.handCount <= 1 && p.boardPower <= 3);
  for (const p of flooding) out.push(`🌊 ${p.name} tiene muchas tierras y poca presión: posible "flood".`);
  const screwed = alive.filter((p) => game.turn >= 4 && p.lands <= 2);
  for (const p of screwed) out.push(`🏜 ${p.name} se quedó corto de tierras (${p.lands} en mesa).`);
  for (const p of players.filter((x) => !x.alive)) out.push(`☠️ ${p.name} fue eliminado en el turno ${p.eliminatedTurn}: ${p.eliminatedReason}.`);
  return out;
}
