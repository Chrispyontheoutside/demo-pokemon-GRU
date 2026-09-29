import {randomBytes, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import showdown from 'pokemon-showdown';
import {Policy, playGen6, type Encoded, type Gen6Request} from './gen6.js';

export class HumanBattle {
  readonly id = randomUUID();
  readonly lines: string[] = [];
  readonly controller = new AbortController();
  readonly done: Promise<void>;
  status: 'playing' | 'finished' | 'failed' = 'playing';
  result = '';
  turn = 0;
  revision = 0;
  touchedAt = Date.now();
  request?: Gen6Request;
  encoded?: Encoded;
  notice = '';
  private pending?: {resolve: (action: number) => void; reject: (error: Error) => void};
  readonly model: Policy;
  constructor(checkpointPath: string) {
    this.model = new Policy(JSON.parse(readFileSync(checkpointPath,'utf8')));
    if (this.model.checkpoint.steps < 1) throw new Error('Train a learner checkpoint before starting a battle.');
    const seed = randomBytes(4).readUInt32BE();
    const prng = new showdown.PRNG(`31,47,${seed >>> 16},${seed & 65535}`);
    this.done = playGen6({seed,signal: this.controller.signal,
      p1: (encoded,request,view) => {
        this.encoded=encoded; this.request=request; this.turn=view.turn; this.revision++;
        return new Promise<number>((resolve,reject) => {this.pending={resolve,reject};});
      },
      p2: encoded => this.model.choose(encoded,() => prng.random()).action,
      onLine: line => {
        if (line.startsWith('|turn|')) this.turn=Number(line.slice(6));
        this.lines.push(line.replace('|player|p1|p1|','|player|p1|You|').replace('|player|p2|p2|','|player|p2|Learner|').replace('|win|p1','|win|You').replace('|win|p2','|win|Learner'));
      },
      onRetry: side => {if (side === 'p1') this.notice='That choice became unavailable. Choose again using the updated options.';},
    }).then(result => {
      this.status='finished';
      this.result=result.truncated ? 'Battle stopped at the 400-turn limit.' : result.winner === 'p1' ? 'You won!' : result.winner === 'p2' ? 'Learner won.' : 'Draw.';
    }).catch(error => {
      if (!this.controller.signal.aborted) {this.status='failed'; this.result=`Battle stopped: ${error.message}`;}
    }).finally(() => {this.pending?.reject(new Error('Battle ended')); this.pending=undefined; this.encoded=undefined;});
  }
  choose(revision: unknown, action: unknown) {
    if (this.status !== 'playing' || !this.pending || revision !== this.revision) throw new Error('This turn has changed. Refresh and choose again.');
    if (typeof action !== 'number' || !this.encoded?.candidates.some(c => c.index === action)) throw new Error('Choose one of the available moves or switches.');
    const pending=this.pending; this.pending=undefined; this.encoded=undefined; this.notice='';
    this.touchedAt=Date.now(); pending.resolve(action);
  }
  forfeit() {
    if (this.status !== 'playing') return;
    this.status='finished'; this.result='You forfeited. Learner won.';
    this.pending?.reject(new Error('Battle forfeited')); this.pending=undefined;
    this.encoded=undefined; this.controller.abort();
    this.lines.push('|win|Learner');
  }
  snapshot() {
    return {id:this.id,status:this.status,result:this.result,turn:this.turn,requestId:this.revision,notice:this.notice,
      checkpoint:{steps:this.model.checkpoint.steps,games:this.model.checkpoint.games,algorithm:this.model.checkpoint.algorithm},
      request:this.request ? {...this.request, side:{pokemon:this.request.side.pokemon.map(p => ({...p,
        baseAbility:showdown.Dex.mod('gen6').abilities.get(p.baseAbility).name,
        item:p.item ? showdown.Dex.mod('gen6').items.get(p.item).name : '',
        moves:p.moves.map(move => showdown.Dex.mod('gen6').moves.get(move).name),
      }))}} : undefined,
      candidates:this.pending ? this.encoded?.candidates.map(({index,choice,label,detail}) => ({index,choice,label,detail})) : [], lines:this.lines};
  }
}
