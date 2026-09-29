#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import showdown from 'pokemon-showdown';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.cache', 'showdown-client-src');
const vendor = path.join(root, 'public', 'vendor', 'showdown');
const revision = 'afa9d4ae645923e42fc8f587080c6bf3d13de2fc';
const archive = `https://github.com/smogon/pokemon-showdown-client/archive/${revision}.tar.gz`;
const upstream = `https://raw.githubusercontent.com/smogon/pokemon-showdown-client/${revision}`;
const clientRoot = path.join(cache, `pokemon-showdown-client-${revision}`);
const sourceRoot = fs.existsSync(path.join(cache, 'play.pokemonshowdown.com')) ? cache : clientRoot;
let babel;

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}
function copy(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}
function write(target, contents) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
async function fetchFile(url, target) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch ${url}: ${response.status}`);
  write(target, Buffer.from(await response.arrayBuffer()));
}
async function ensureSource() {
  if (fs.existsSync(path.join(sourceRoot, 'play.pokemonshowdown.com', 'src', 'battle.ts'))) return;
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  const tarball = path.join(cache, `client-${revision}.tar.gz`);
  await fetchFile(archive, tarball);
  run('tar', ['-xzf', tarball, '-C', cache]);
}
function compile(files, target, opts) {
  const code = files.map(file => {
    const result = babel.transformFileSync(path.join(sourceRoot, file), opts);
    return result?.code || '';
  }).join('\n');
  write(path.join(sourceRoot, target), `${code}\n`);
}
async function build() {
  const require = createRequire(path.join(sourceRoot, 'package.json'));
  const source = path.join(sourceRoot, 'play.pokemonshowdown.com');
  const configDir = path.join(source, 'config');
  const dataDir = path.join(source, 'data');
  const textDir = path.join(dataDir, 'text');
  const jsDir = path.join(source, 'js');
  fs.mkdirSync(textDir, { recursive: true });
  fs.mkdirSync(jsDir, { recursive: true });
  await fetchFile('https://play.pokemonshowdown.com/data/text/en.js', path.join(textDir, 'en.js'));
  await fetchFile('https://play.pokemonshowdown.com/data/pokedex-mini.js', path.join(dataDir, 'pokedex-mini.js'));
  await fetchFile('https://play.pokemonshowdown.com/data/pokedex-mini-bw.js', path.join(dataDir, 'pokedex-mini-bw.js'));
  copy(path.join(root, 'node_modules', 'pokemon-showdown', 'server', 'chat-formatter.ts'), path.join(sourceRoot, 'caches', 'pokemon-showdown', 'server', 'chat-formatter.ts'));

  if (!fs.existsSync(path.join(sourceRoot, 'node_modules', '@babel', 'core'))) {
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], sourceRoot);
  }
  babel = require('@babel/core');
  const opts = {
    cwd: sourceRoot,
    babelrc: false,
    sourceMaps: false,
    compact: true,
    comments: true,
    plugins: [
      ['@babel/plugin-transform-typescript', { isTSX: true, allowDeclareFields: true }],
      ['@babel/plugin-transform-react-jsx', { pragma: 'preact.h', pragmaFrag: 'preact.Fragment', useBuiltIns: true }],
      ['@babel/plugin-transform-class-properties', { loose: true }],
      'remove-import-export',
      ['@babel/plugin-transform-logical-assignment-operators'],
      ['@babel/plugin-transform-nullish-coalescing-operator', { loose: true }],
      ['@babel/plugin-transform-optional-chaining', { loose: true }],
      ['@babel/plugin-transform-object-rest-spread', { loose: true, useBuiltIns: true }],
      '@babel/plugin-transform-optional-catch-binding',
      '@babel/plugin-transform-exponentiation-operator',
      '@babel/plugin-transform-arrow-functions',
      ['@babel/plugin-transform-block-scoping', { throwIfClosureRequired: true }],
      ['@babel/plugin-transform-classes', { loose: true }],
      ['@babel/plugin-transform-computed-properties', { loose: true }],
      ['@babel/plugin-transform-destructuring', { loose: true, useBuiltIns: true }],
      ['@babel/plugin-transform-for-of', { assumeArray: true }],
      '@babel/plugin-transform-literals', '@babel/plugin-transform-parameters',
      '@babel/plugin-transform-shorthand-properties', ['@babel/plugin-transform-spread', { loose: true }],
      path.join(sourceRoot, 'build-tools', 'babel-plugin-inline-tl'),
      ['@babel/plugin-transform-template-literals', { loose: true }],
      '@babel/plugin-transform-member-expression-literals', '@babel/plugin-transform-property-literals',
      '@babel/plugin-transform-strict-mode',
    ],
  };
  compile([
    'play.pokemonshowdown.com/src/battle-dex.ts', 'play.pokemonshowdown.com/src/battle-teams.ts',
    'play.pokemonshowdown.com/src/battle-dex-data.ts', 'play.pokemonshowdown.com/src/battle-log.ts',
    'play.pokemonshowdown.com/src/battle-log-misc.js', 'caches/pokemon-showdown/server/chat-formatter.ts',
    'play.pokemonshowdown.com/data/text/en.js', 'play.pokemonshowdown.com/src/battle-text-parser.ts',
  ], 'play.pokemonshowdown.com/js/battledata.js', opts);
  fs.appendFileSync(path.join(source, 'js/battledata.js'), "\nDex.resourcePrefix='https://play.pokemonshowdown.com/';Dex.fxPrefix='https://play.pokemonshowdown.com/fx/';\n");
  compile(['play.pokemonshowdown.com/src/battle-animations.ts', 'play.pokemonshowdown.com/src/battle-animations-moves.ts'], 'play.pokemonshowdown.com/data/graphics.js', opts);
  compile(['play.pokemonshowdown.com/src/battle-sound.ts'], 'play.pokemonshowdown.com/js/battle-sound.js', opts);
  compile(['play.pokemonshowdown.com/src/battle.ts', 'play.pokemonshowdown.com/src/battle-tooltips.ts'], 'play.pokemonshowdown.com/js/battle.js', opts);

  write(path.join(configDir, 'config.js'), `var Config = Config || {}; Config.routes = {root: 'pokemonshowdown.com', client: 'play.pokemonshowdown.com', dex: 'dex.pokemonshowdown.com', replays: 'replay.pokemonshowdown.com', users: 'pokemonshowdown.com/users', teams: 'teams.pokemonshowdown.com'}; Config.server = {id: 'showdown', host: 'sim3.psim.us', port: 443, registered: true};\n`);
  fs.mkdirSync(vendor, { recursive: true });
  // The replay renderer needs species/form metadata as well as sprite dimensions.
  // Export display tables from the installed simulator, avoiding live script loads.
  for (const [name, entries] of [
    ['Pokedex', showdown.Dex.species.all()], ['Movedex', showdown.Dex.moves.all()],
    ['Abilities', showdown.Dex.abilities.all()], ['Items', showdown.Dex.items.all()],
  ]) {
    write(path.join(vendor, `${name.toLowerCase()}.js`), `exports.Battle${name}=${JSON.stringify(Object.fromEntries(entries.map(entry => [entry.id, entry])))};\n`);
  }
  const files = [
    ['js/lib/ps-polyfill.js', 'ps-polyfill.js'], ['js/lib/jquery-1.11.0.min.js', 'jquery-1.11.0.min.js'],
    ['js/lib/html-sanitizer-minified.js', 'html-sanitizer-minified.js'], ['js/battle-sound.js', 'battle-sound.js'],
    ['js/battledata.js', 'battledata.js'], ['data/pokedex-mini.js', 'pokedex-mini.js'],
    ['data/pokedex-mini-bw.js', 'pokedex-mini-bw.js'], ['data/graphics.js', 'graphics.js'],
    ['js/battle.js', 'battle.js'], ['config/config.js', 'config.js'],
  ];
  for (const [from, to] of files) copy(path.join(source, from), path.join(vendor, to));
  for (const css of ['battle.css', 'battle-log.css', 'replay.css', 'utilichart.css', 'font-awesome.css']) copy(path.join(source, 'style', css), path.join(vendor, css));
  for (const font of fs.readdirSync(path.join(source, 'style', 'fonts'))) copy(path.join(source, 'style', 'fonts', font), path.join(vendor, 'fonts', font));
}

await ensureSource();
await build();
const manifest = {
  repository: 'https://github.com/smogon/pokemon-showdown-client', revision,
  source: { battle: `${upstream}/play.pokemonshowdown.com/src/battle.ts`, replayEmbed: `${upstream}/play.pokemonshowdown.com/src/replay-embed.ts` },
  generated: Object.fromEntries(fs.readdirSync(vendor).filter(file => file.endsWith('.js') || file.endsWith('.css')).map(file => [file, sha256(path.join(vendor, file))])),
  media: 'Showdown sprites and battle effects resolve from play.pokemonshowdown.com at runtime; renderer code and styles are local.',
};
write(path.join(root, 'vendor-sources.json'), `${JSON.stringify(manifest, null, 2)}\n`);
write(path.join(root, 'public', 'vendor', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Showdown viewer assets built from ${revision}`);
