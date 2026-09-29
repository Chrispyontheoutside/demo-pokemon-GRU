#!/usr/bin/env node
// Measures behavioural rates of a scripted agent playing itself on human-like teams: voluntary switches per game (per side) and Protect share of moves.
// Targets from OUR OWN ladder games (279 games): humans 0.48 voluntary switches per game, 11.8% Protect share of moves.
//   node scripts/measure-behavior.mjs --agent heuristic|guarded [--games 200] [--tuning '{"switchOther":-0.05}']
import {readFileSync} from 'node:fs';
import showdown from 'pokemon-showdown';
import {DirectGame} from '../dist/src/direct-battle.js';
import {act} from '../dist/src/search.js';
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const agent = opt('--agent', 'guarded'), games = Number(opt('--games', 200));
const packs = Array.from({length: 120}, (_, i) => JSON.parse(readFileSync(`runs/champions-vgc-2026-reg-mc/teams/human-${i + 1}.json`, 'utf8')).pack);
const PROTECT = new Set(['protect', 'detect', 'kingsshield', 'spikyshield', 'banefulbunker', 'obstruct', 'silktrap', 'burningbulwark']);
const prng = n => { const rng = new showdown.PRNG(`41,53,${(n >>> 16) & 65535},${n & 65535}`); return () => rng.random(); };
let switches = 0, moves = 0, protects = 0, sideGames = 0, turns = 0;
for (let g = 0; g < games; g++) {
  const seed = 9800000000 + g, random = prng(seed);
  const game = DirectGame.create([packs[g % 120], packs[(g * 7 + 3) % 120]], [17, 29, (seed >>> 16) & 65535, seed & 65535]);
  const agents = {p1: agent, p2: agent};
  let guard = 0; sideGames += 2;
  while (!game.ended && guard++ < 300) {
    for (const side of game.pending()) {
      const request = game.requests[side], choice = act(game, side, agents[side], random);
      if (!request?.active) continue;
      choice.split(',').map(x => x.trim()).forEach((part, slot) => {
        const tokens = part.split(/\s+/);
        if (tokens[0] === 'switch' && !request.forceSwitch) switches++;
        if (tokens[0] === 'move') { moves++; const id = request.active[slot]?.moves?.[Number(tokens[1]) - 1]?.id; if (PROTECT.has(id)) protects++; }
      });
    }
    turns++;
  }
}
console.log(JSON.stringify({agent, tuning: process.env.GUARD_TUNING ?? 'default', games, voluntarySwitchesPerGamePerSide: +(switches / sideGames).toFixed(3), protectShareOfMoves: +(protects / Math.max(1, moves)).toFixed(3),
  humanTargets: {voluntarySwitchesPerGame: 0.48, protectShare: 0.118}}));
