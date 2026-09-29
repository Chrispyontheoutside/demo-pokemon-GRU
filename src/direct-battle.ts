// Direct (non-stream) Champions battle driver that supports cloning, for simulator search and expert iteration.
// It feeds each side's VisibleState the same per-side protocol lines the BattleStream path delivers, so `encode` sees identical inputs.
import {createRequire} from 'node:module';
import showdown from 'pokemon-showdown';
import {CHAMPIONS_FORMAT, encode, VisibleState, type Encoded, type SideId} from './champions.js';

const require = createRequire(import.meta.url);
const {extractChannelMessages} = require('pokemon-showdown/dist/sim/battle.js') as {extractChannelMessages: (message: string, ids: number[]) => Record<number, string[]>};
const Battle = (showdown as any).Battle;
const {Teams} = showdown as any;

export class DirectGame {
  battle: any;
  views: Record<SideId, VisibleState> = {p1: new VisibleState(), p2: new VisibleState()};
  requests: Partial<Record<SideId, any>> = {};
  hidden: Partial<Record<SideId, number[]>> = {};

  static create(packedTeams: [string, string], seed: number[]) {
    const game = new DirectGame();
    game.battle = new Battle({formatid: CHAMPIONS_FORMAT, seed, send: game.onSend,
      p1: {name: 'p1', team: Teams.unpack(packedTeams[0])}, p2: {name: 'p2', team: Teams.unpack(packedTeams[1])}});
    game.battle.sendUpdates();   // flush the opening log and both team-preview requests
    return game;
  }

  private onSend = (type: string, data: string | string[]) => {
    if (type === 'update') {
      const text = Array.isArray(data) ? data.join('\n') : String(data);
      const channels = extractChannelMessages(text, [1, 2]);
      for (const line of channels[1] ?? []) this.views.p1.receive(line);
      for (const line of channels[2] ?? []) this.views.p2.receive(line);
    } else if (type === 'sideupdate') {
      const [side, rest] = String(data).split(/\n(.*)/s) as [SideId, string];
      if (rest?.startsWith('|request|')) {
        const json = rest.slice(9);
        this.requests[side] = json && json !== 'null' ? JSON.parse(json) : undefined;
      }
    }
  };

  get ended(): boolean { return Boolean(this.battle.ended); }
  get winner(): SideId | null { return this.battle.winner ? (this.battle.winner === 'p1' ? 'p1' : 'p2') : null; }
  /** Sides that must choose now (a `wait` request or no request means the side is not being asked). */
  pending(): SideId[] {
    if (this.ended) return [];
    return (['p1', 'p2'] as SideId[]).filter(side => this.requests[side] && !this.requests[side].wait);
  }
  encodeFor(side: SideId): Encoded { return encode(this.requests[side], this.views[side], side); }

  /**
   * Applies a choice for `side`. Returns false if the simulator rejects it (e.g. a hidden trap), leaving the request pending.
   * The engine commits the turn automatically once every pending side has chosen.
   */
  choose(side: SideId, choice: string): boolean {
    const accepted = this.battle.choose(side, choice) !== false;
    this.battle.sendUpdates();   // the stream wrapper does this after every command; it emits the log slice and the next requests
    return accepted;
  }

  clone(): DirectGame {
    const copy = new DirectGame();
    copy.battle = Battle.fromJSON(JSON.stringify(this.battle.toJSON()));
    copy.battle.restart(copy.onSend);
    copy.views = {p1: this.views.p1.clone(), p2: this.views.p2.clone()};
    copy.requests = {p1: this.requests.p1, p2: this.requests.p2};   // requests are replaced, never mutated, by the simulator
    copy.hidden = {p1: this.hidden.p1 && [...this.hidden.p1], p2: this.hidden.p2 && [...this.hidden.p2]};
    return copy;
  }
}
