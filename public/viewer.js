(() => {
  'use strict';

  const parent = window.parent;
  const sameOrigin = event => event.source === parent && event.origin === window.location.origin;
  const $ = window.jQuery;
  window.Dex.resourcePrefix = 'https://play.pokemonshowdown.com/';
  window.Dex.fxPrefix = 'https://play.pokemonshowdown.com/fx/';
  const frame = $('.battle');
  const logFrame = $('.battle-log');
  const status = document.querySelector('.viewer-status');
  const error = document.querySelector('.viewer-error');
  const turnSlider = document.querySelector('[data-action="turn"]');
  const turnOutput = document.querySelector('[data-turn]');
  const controls = [...document.querySelectorAll('.viewer-controls [data-action]')];
  const speedTable = {
    hyperfast: [40, 1], fast: [50, 1], normal: [300, 1], slow: [500, 1000], reallyslow: [1000, 3000],
  };
  let battle = null;
  let live = false;
  let lines = [];
  let muted = true;
  let autoplay = false;
  const stage = document.querySelector('.showdown');
  new ResizeObserver(() => {
    const scale = Math.min(1, stage.clientWidth / 640);
    stage.style.setProperty('--battle-scale', String(scale));
    stage.style.setProperty('--battle-height', `${360 * scale}px`);
  }).observe(stage);

  function send(type, payload = {}) {
    parent.postMessage({ type, ...payload }, window.location.origin);
  }
  function showError(message) {
    error.textContent = message instanceof Error ? message.message : String(message);
    error.hidden = false;
    status.textContent = 'Battle viewer error';
  }
  function setEnabled(enabled) {
    controls.forEach(control => { if (control.dataset.action !== 'mute') control.disabled = !enabled; });
  }
  function updateTurn() {
    if (!battle) return;
    const turn = Math.max(0, battle.turn || 0);
    const max = Math.max(turn, lines.reduce((n, line) => {
      const match = /^\|turn\|(\d+)/.exec(line);
      return match ? Math.max(n, Number(match[1])) : n;
    }, 0));
    turnSlider.max = String(max);
    turnSlider.value = String(Math.min(turn, max));
    turnOutput.value = String(turn);
    turnOutput.textContent = String(turn);
    send('viewer-turn', { turn });
  }
  function updateStatus(state) {
    if (!battle) return;
    if (state === 'error') showError('Showdown could not parse this battle log. The text log remains available below.');
    if (battle.ended) status.textContent = 'Battle finished';
    else if (state === 'atqueueend') status.textContent = live ? 'Live stream waiting for more events' : 'Replay ready';
    else if (state === 'playing') status.textContent = live ? 'Live battle playing' : 'Replay playing';
    else if (state === 'paused' || state === 'turn') status.textContent = live ? 'Live battle paused' : 'Replay paused';
    updateTurn();
    const toggle = document.querySelector('[data-action="toggle"]');
    toggle.textContent = battle.paused ? 'Play' : 'Pause';
  }
  function applySpeed(value) {
    if (!battle || !speedTable[value]) return;
    const [fade, delay] = speedTable[value];
    battle.messageFadeTime = fade;
    battle.messageShownTime = delay;
    battle.scene.updateAcceleration();
  }
  function destroyBattle() {
    if (!battle) return;
    try { battle.destroy(); } catch {}
    battle = null;
    frame.empty();
    logFrame.empty();
  }
  function loadBattle(nextLines, isLive, shouldAutoplay = false) {
    if (!Array.isArray(nextLines)) throw new Error('Viewer load requires a lines array.');
    lines = nextLines.filter(line => typeof line === 'string');
    live = Boolean(isLive);
    autoplay = Boolean(shouldAutoplay);
    error.hidden = true;
    destroyBattle();
    battle = new window.Battle({
      id: 'showdown-arena',
      $frame: frame,
      $logFrame: logFrame,
      log: [...lines],
      isReplay: !live,
      paused: true,
      autoresize: false,
    });
    battle.setMute(muted);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) battle.scene.animationOff();
    battle.subscribe(updateStatus);
    setEnabled(true);
    updateStatus('paused');
    if (autoplay) { applySpeed('fast'); battle.seekTurn(Infinity); battle.play(); }
  }
  function appendBattle(nextLines) {
    if (!Array.isArray(nextLines) || !battle) return;
    nextLines.filter(line => typeof line === 'string').forEach(line => {
      lines.push(line);
      battle.add(line);
    });
    updateTurn();
    if (autoplay) { battle.seekTurn(Infinity); battle.play(); }
  }
  function action(name) {
    if (!battle) return;
    if (name === 'toggle') battle.paused ? battle.play() : battle.pause();
    if (name === 'back') battle.seekBy(-1);
    if (name === 'forward') battle.seekBy(1);
    if (name === 'live') { battle.seekTurn(Infinity); battle.play(); }
    if (name === 'mute') {
      muted = !muted;
      battle.setMute(muted);
      const button = document.querySelector('[data-action="mute"]');
      button.textContent = muted ? 'Muted' : 'Sound on';
      button.setAttribute('aria-pressed', String(muted));
    }
  }
  document.querySelector('.viewer-controls').addEventListener('click', event => {
    const target = event.target.closest('[data-action]');
    if (target && target.dataset.action !== 'speed' && target.dataset.action !== 'turn') action(target.dataset.action);
  });
  document.querySelector('[data-action="speed"]').addEventListener('change', event => applySpeed(event.target.value));
  turnSlider.addEventListener('input', event => {
    if (!battle) return;
    battle.seekTurn(Number(event.target.value));
    updateTurn();
  });
  window.addEventListener('message', event => {
    if (!sameOrigin(event) || !event.data || typeof event.data.type !== 'string') return;
    try {
      if (event.data.type === 'load') loadBattle(event.data.lines, event.data.live, event.data.autoplay);
      else if (event.data.type === 'append') appendBattle(event.data.lines);
    } catch (loadError) { showError(loadError); }
  });
  setEnabled(false);
  status.textContent = 'Ready for battle data';
  send('viewer-ready');
})();
